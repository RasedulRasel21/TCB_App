import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
  Form,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  Banner,
  BlockStack,
  Text,
  Box,
  DataTable,
  Badge,
  InlineStack,
  Checkbox,
  Divider,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";
import { randomBytes } from "crypto";
import { createAppstleService } from "../services/appstle.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Get gift settings
  let settings = await prisma.giftSettings.findUnique({
    where: { shop },
  });

  // Create default settings if not exist
  if (!settings) {
    settings = await prisma.giftSettings.create({
      data: {
        shop,
        enabled: true,
        triggerOrderNumbers: "3,5,10,15,20",
        maxGiftProducts: 3,
        giftExpiryDays: 14,
        emailDelayDays: 0,
      },
    });
  }

  // Get gift eligibilities
  const eligibilities = await prisma.giftEligibility.findMany({
    where: { shop },
    include: { selections: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Get synced subscribers with order counts for the summary
  const subscribers = await prisma.syncedSubscriber.findMany({
    where: { shop },
    orderBy: { totalOrdersDelivered: "desc" },
  });

  const triggerNumbers = settings.triggerOrderNumbers
    .split(",")
    .map((n) => parseInt(n.trim()))
    .filter((n) => !isNaN(n));

  // Count how many subscribers match each trigger
  const qualifyingSummary = triggerNumbers.map((trigger) => ({
    trigger,
    count: subscribers.filter((s) => s.totalOrdersDelivered >= trigger).length,
    exactMatch: subscribers.filter((s) => s.totalOrdersDelivered === trigger).length,
  }));

  // Check if Appstle API key is configured
  const appSettings = await prisma.appSettings.findUnique({
    where: { shop },
  });

  return json({
    settings,
    shop,
    hasApiKey: !!appSettings?.appstleApiKey,
    subscriberCount: subscribers.length,
    qualifyingSummary,
    eligibilities: eligibilities.map((e) => ({
      id: e.id,
      subscriptionContractId: e.subscriptionContractId,
      customerEmail: e.customerEmail,
      customerName: e.customerName,
      orderNumber: e.orderNumber,
      status: e.status,
      giftToken: e.giftToken,
      emailSentAt: e.emailSentAt?.toISOString(),
      selectedAt: e.selectedAt?.toISOString(),
      appliedAt: e.appliedAt?.toISOString(),
      expiresAt: e.expiresAt.toISOString(),
      createdAt: e.createdAt.toISOString(),
      selectionsCount: e.selections.length,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "saveSettings") {
    const enabled = formData.get("enabled") === "true";
    const triggerOrderNumbers = formData.get("triggerOrderNumbers") as string;
    const maxGiftProducts = parseInt(formData.get("maxGiftProducts") as string) || 3;
    const giftExpiryDays = parseInt(formData.get("giftExpiryDays") as string) || 14;
    const emailDelayDays = Math.max(0, parseInt(formData.get("emailDelayDays") as string) || 0);
    const eligibleProductIds = formData.get("eligibleProductIds") as string;
    const emailSubject = formData.get("emailSubject") as string;

    await prisma.giftSettings.upsert({
      where: { shop },
      create: {
        shop,
        enabled,
        triggerOrderNumbers,
        maxGiftProducts,
        giftExpiryDays,
        emailDelayDays,
        eligibleProductIds: eligibleProductIds || null,
        emailSubject,
      },
      update: {
        enabled,
        triggerOrderNumbers,
        maxGiftProducts,
        giftExpiryDays,
        emailDelayDays,
        eligibleProductIds: eligibleProductIds || null,
        emailSubject,
      },
    });

    return json({ success: true, message: "Gift settings saved!" });
  }

  if (intent === "processEligible") {
    const settings = await prisma.giftSettings.findUnique({
      where: { shop },
    });

    if (!settings?.enabled) {
      return json({ success: false, error: "Gift system is disabled" });
    }

    const triggerNumbers = settings.triggerOrderNumbers
      .split(",")
      .map((n) => parseInt(n.trim()))
      .filter((n) => !isNaN(n));

    const subscribers = await prisma.syncedSubscriber.findMany({
      where: { shop },
    });

    let created = 0;
    let skipped = 0;

    for (const subscriber of subscribers) {
      // Check each trigger number the subscriber qualifies for
      for (const trigger of triggerNumbers) {
        if (subscriber.totalOrdersDelivered >= trigger) {
          const existing = await prisma.giftEligibility.findUnique({
            where: {
              shop_subscriptionContractId_orderNumber: {
                shop,
                subscriptionContractId: subscriber.contractId,
                orderNumber: trigger,
              },
            },
          });

          if (!existing) {
            const giftToken = randomBytes(32).toString("hex");
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + settings.giftExpiryDays);

            await prisma.giftEligibility.create({
              data: {
                shop,
                subscriptionContractId: subscriber.contractId,
                customerId: subscriber.customerId,
                customerEmail: subscriber.customerEmail || "",
                customerName: `${subscriber.customerFirstName || ""} ${subscriber.customerLastName || ""}`.trim(),
                orderNumber: trigger,
                giftToken,
                status: "pending",
                expiresAt,
              },
            });
            created++;
          } else {
            skipped++;
          }
        }
      }
    }

    return json({
      success: true,
      message: `Processed ${subscribers.length} subscribers. Created ${created} new eligibilities (${skipped} already existed).`,
    });
  }

  if (intent === "sendEmails") {
    const settings = await prisma.giftSettings.findUnique({
      where: { shop },
    });

    if (!settings?.enabled) {
      return json({ success: false, error: "Gift system is disabled" });
    }

    const appSettings = await prisma.appSettings.findUnique({
      where: { shop },
    });

    if (!appSettings?.appstleApiKey) {
      return json({ success: false, error: "Appstle API key not configured. Go to Settings first." });
    }

    const emailDelayDays = settings.emailDelayDays || 0;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - emailDelayDays);

    const pendingEligibilities = await prisma.giftEligibility.findMany({
      where: {
        shop,
        status: "pending",
        emailSentAt: null,
        createdAt: { lte: cutoffDate },
        expiresAt: { gt: new Date() },
      },
    });

    if (pendingEligibilities.length === 0) {
      return json({
        success: true,
        message: emailDelayDays > 0
          ? `No pending eligibilities past the ${emailDelayDays}-day delay period.`
          : "No pending eligibilities to send emails for.",
      });
    }

    const service = createAppstleService(
      appSettings.appstleApiKey,
      shop,
      appSettings.appstleApiUrl
    );

    // Mark ALL as email_sent with timestamp BEFORE calling API
    // This is the lock - prevents cron or any other process from picking these up
    const eligibilityIds = pendingEligibilities.map((e) => e.id);
    await prisma.giftEligibility.updateMany({
      where: { id: { in: eligibilityIds } },
      data: { status: "email_sent", emailSentAt: new Date() },
    });

    let sent = 0;
    let failed = 0;

    for (const eligibility of pendingEligibilities) {
      try {
        const emailResult = await service.sendMagicLinkEmail(eligibility.customerEmail);

        if (emailResult.success) {
          sent++;
        } else {
          await prisma.giftEligibility.update({
            where: { id: eligibility.id },
            data: { status: "email_failed" },
          });
          failed++;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch {
        await prisma.giftEligibility.update({
          where: { id: eligibility.id },
          data: { status: "email_failed" },
        });
        failed++;
      }
    }

    return json({
      success: true,
      message: `Email processing complete: ${sent} sent, ${failed} failed out of ${pendingEligibilities.length} pending.`,
    });
  }

  if (intent === "resetStatus") {
    const eligibilityId = formData.get("eligibilityId") as string;

    if (!eligibilityId) {
      return json({ success: false, error: "Missing eligibility ID" });
    }

    await prisma.giftSelection.deleteMany({
      where: { giftEligibilityId: eligibilityId },
    });

    await prisma.giftEligibility.update({
      where: { id: eligibilityId },
      data: {
        status: "pending",
        selectedAt: null,
        appliedAt: null,
      },
    });

    return json({
      success: true,
      message: "Gift status reset to pending. Customer can select again.",
    });
  }

  return json({ success: false, error: "Invalid action" });
};

export default function Gifts() {
  const { settings, eligibilities, shop, hasApiKey, subscriberCount, qualifyingSummary } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSubmitting = navigation.state === "submitting";

  const handleResetStatus = (eligibilityId: string) => {
    if (confirm("Reset this gift status to pending? This will allow the customer to select gifts again.")) {
      const formData = new FormData();
      formData.append("intent", "resetStatus");
      formData.append("eligibilityId", eligibilityId);
      submit(formData, { method: "post" });
    }
  };

  const [enabled, setEnabled] = useState(settings.enabled);
  const [triggerOrderNumbers, setTriggerOrderNumbers] = useState(settings.triggerOrderNumbers);
  const [maxGiftProducts, setMaxGiftProducts] = useState(String(settings.maxGiftProducts));
  const [giftExpiryDays, setGiftExpiryDays] = useState(String(settings.giftExpiryDays));
  const [emailDelayDays, setEmailDelayDays] = useState(String(Math.max(0, settings.emailDelayDays)));
  const [eligibleProductIds, setEligibleProductIds] = useState(settings.eligibleProductIds || "");
  const [emailSubject, setEmailSubject] = useState(settings.emailSubject);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge tone="attention">Pending - Awaiting Email</Badge>;
      case "sending":
        return <Badge tone="info">Sending...</Badge>;
      case "email_failed":
        return <Badge tone="critical">Email Failed</Badge>;
      case "email_sent":
        return <Badge tone="info">Email Sent</Badge>;
      case "selected":
        return <Badge tone="warning">Gifts Selected</Badge>;
      case "applied":
        return <Badge tone="success">Applied to Subscription</Badge>;
      case "expired":
        return <Badge tone="critical">Expired</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const pendingCount = eligibilities.filter((e: any) => e.status === "pending").length;
  const emailSentCount = eligibilities.filter((e: any) => e.status === "email_sent").length;
  const selectedCount = eligibilities.filter((e: any) => e.status === "selected").length;
  const appliedCount = eligibilities.filter((e: any) => e.status === "applied").length;

  const eligibilityRows = eligibilities.map((e: any) => [
    e.customerEmail,
    e.customerName || "N/A",
    `Order #${e.orderNumber}`,
    getStatusBadge(e.status),
    e.emailSentAt ? new Date(e.emailSentAt).toLocaleDateString() : "-",
    e.selectedAt ? new Date(e.selectedAt).toLocaleDateString() : "-",
    e.selectionsCount > 0 ? `${e.selectionsCount} products` : "-",
    new Date(e.expiresAt).toLocaleDateString(),
    <a
      href={`https://${shop}/pages/gift-selection?token=${e.giftToken}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: "#2c6ecb", textDecoration: "underline" }}
    >
      Open Link
    </a>,
    <Button size="slim" tone="critical" onClick={() => handleResetStatus(e.id)}>
      Reset
    </Button>,
  ]);

  return (
    <Page
      title="Gift Management"
      backAction={{ content: "Home", url: "/app" }}
    >
      <BlockStack gap="500">
        {(actionData as any)?.success && (actionData as any).message && (
          <Banner tone="success" onDismiss={() => {}}>
            <Text as="p">{(actionData as any).message}</Text>
          </Banner>
        )}

        {(actionData as any)?.error && (
          <Banner tone="critical" onDismiss={() => {}}>
            <Text as="p">{(actionData as any).error}</Text>
          </Banner>
        )}

        <Banner tone="info">
          <Text as="p">
            Gifts are processed automatically via webhook (on new orders) and cron (every 6 hours).
            Use the buttons below for manual processing when needed.
          </Text>
        </Banner>

        <Layout>
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              {/* Settings Card */}
              <Card>
                <Form method="post">
                  <input type="hidden" name="intent" value="saveSettings" />
                  <input type="hidden" name="enabled" value={enabled ? "true" : "false"} />

                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">Gift Settings</Text>

                    <Checkbox
                      label="Enable Gift System"
                      checked={enabled}
                      onChange={setEnabled}
                    />

                    <TextField
                      label="Trigger Order Numbers"
                      name="triggerOrderNumbers"
                      value={triggerOrderNumbers}
                      onChange={setTriggerOrderNumbers}
                      helpText="Comma-separated order numbers (e.g., 3,5,10,15,20)"
                      autoComplete="off"
                    />

                    <TextField
                      label="Max Gift Products"
                      name="maxGiftProducts"
                      type="number"
                      value={maxGiftProducts}
                      onChange={setMaxGiftProducts}
                      helpText="Maximum products customer can select"
                      autoComplete="off"
                    />

                    <TextField
                      label="Gift Link Expiry (days)"
                      name="giftExpiryDays"
                      type="number"
                      value={giftExpiryDays}
                      onChange={setGiftExpiryDays}
                      autoComplete="off"
                    />

                    <TextField
                      label="Email Delay (days)"
                      name="emailDelayDays"
                      type="number"
                      value={emailDelayDays}
                      onChange={setEmailDelayDays}
                      min={0}
                      helpText="0 = send immediately on milestone. Greater than 0 = cron sends after N days."
                      autoComplete="off"
                    />

                    <TextField
                      label="Eligible Product IDs"
                      name="eligibleProductIds"
                      value={eligibleProductIds}
                      onChange={setEligibleProductIds}
                      helpText="Comma-separated product IDs (leave empty for all products)"
                      autoComplete="off"
                      multiline={2}
                    />

                    <TextField
                      label="Email Subject"
                      name="emailSubject"
                      value={emailSubject}
                      onChange={setEmailSubject}
                      autoComplete="off"
                    />

                    <Button submit variant="primary" loading={isSubmitting}>
                      Save Settings
                    </Button>
                  </BlockStack>
                </Form>
              </Card>

              {/* Subscriber Summary */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Subscriber Summary</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {subscriberCount} synced subscribers
                  </Text>
                  {qualifyingSummary.map((q: any) => (
                    <InlineStack key={q.trigger} align="space-between">
                      <Text as="p" variant="bodySm">Order #{q.trigger}:</Text>
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        {q.exactMatch} exact / {q.count} eligible
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </Card>

              {/* Actions Card */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Actions</Text>

                  <Form method="post">
                    <input type="hidden" name="intent" value="processEligible" />
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Check synced subscribers and create gift eligibilities for those who hit trigger milestones.
                      </Text>
                      <Button submit fullWidth loading={isSubmitting}>
                        Process Eligible Now
                      </Button>
                    </BlockStack>
                  </Form>

                  <Divider />

                  <Form method="post">
                    <input type="hidden" name="intent" value="sendEmails" />
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Send magic link emails to pending eligibilities
                        {settings.emailDelayDays > 0
                          ? ` (past ${settings.emailDelayDays}-day delay)`
                          : " (no delay)"}.
                      </Text>
                      <Button submit fullWidth loading={isSubmitting} disabled={!hasApiKey}>
                        Send Emails Now
                      </Button>
                    </BlockStack>
                  </Form>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section>
            <BlockStack gap="400">
              {/* Status Summary */}
              {eligibilities.length > 0 && (
                <Card>
                  <InlineStack gap="400" align="space-between">
                    <BlockStack gap="100" inlineAlign="center">
                      <Text as="p" variant="headingLg">{pendingCount}</Text>
                      <Badge tone="attention">Pending</Badge>
                    </BlockStack>
                    <BlockStack gap="100" inlineAlign="center">
                      <Text as="p" variant="headingLg">{emailSentCount}</Text>
                      <Badge tone="info">Email Sent</Badge>
                    </BlockStack>
                    <BlockStack gap="100" inlineAlign="center">
                      <Text as="p" variant="headingLg">{selectedCount}</Text>
                      <Badge tone="warning">Selected</Badge>
                    </BlockStack>
                    <BlockStack gap="100" inlineAlign="center">
                      <Text as="p" variant="headingLg">{appliedCount}</Text>
                      <Badge tone="success">Applied</Badge>
                    </BlockStack>
                  </InlineStack>
                </Card>
              )}

              {/* Eligibilities Table */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Gift Eligibilities ({eligibilities.length})
                  </Text>

                  {eligibilities.length > 0 ? (
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text", "text", "text"]}
                      headings={[
                        "Email",
                        "Name",
                        "Trigger",
                        "Status",
                        "Email Sent",
                        "Selected",
                        "Products",
                        "Expires",
                        "Gift Link",
                        "Actions",
                      ]}
                      rows={eligibilityRows}
                    />
                  ) : (
                    <Box padding="400">
                      <Text as="p" alignment="center" tone="subdued">
                        No gift eligibilities yet. Sync subscribers first, then click "Process Eligible Now" to create eligibilities.
                      </Text>
                    </Box>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

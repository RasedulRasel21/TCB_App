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
  FormLayout,
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
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";
import { randomBytes } from "crypto";

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
        emailDelayDays: 7,
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

  // Get subscribers who qualify for gifts
  const subscribers = await prisma.syncedSubscriber.findMany({
    where: { shop },
    orderBy: { totalOrdersDelivered: "desc" },
  });

  return json({
    settings,
    shop,
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
    subscribers: subscribers.map((s) => ({
      id: s.id,
      contractId: s.contractId,
      customerEmail: s.customerEmail,
      customerName: `${s.customerFirstName || ""} ${s.customerLastName || ""}`.trim(),
      totalOrders: s.totalOrdersDelivered,
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
    const emailDelayDays = parseInt(formData.get("emailDelayDays") as string) || 7;
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

  if (intent === "createGiftManually") {
    const subscriptionContractId = formData.get("subscriptionContractId") as string;
    const customerEmail = formData.get("customerEmail") as string;
    const customerName = formData.get("customerName") as string;
    const orderNumber = parseInt(formData.get("orderNumber") as string) || 3;

    // Get settings for expiry
    const settings = await prisma.giftSettings.findUnique({
      where: { shop },
    });

    const expiryDays = settings?.giftExpiryDays || 14;
    const giftToken = randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    try {
      await prisma.giftEligibility.create({
        data: {
          shop,
          subscriptionContractId,
          customerId: "manual",
          customerEmail,
          customerName,
          orderNumber,
          giftToken,
          status: "pending",
          expiresAt,
        },
      });

      const giftLink = `https://${shop}/pages/gift-selection?token=${giftToken}`;

      return json({
        success: true,
        message: "Gift eligibility created!",
        giftLink,
      });
    } catch (error) {
      return json({
        success: false,
        error: "Failed to create gift eligibility. It may already exist.",
      });
    }
  }

  if (intent === "resetStatus") {
    const eligibilityId = formData.get("eligibilityId") as string;

    if (!eligibilityId) {
      return json({ success: false, error: "Missing eligibility ID" });
    }

    // Reset the status back to pending and delete selections
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

  if (intent === "processEligible") {
    // Get settings
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

    // Get subscribers who qualify
    const subscribers = await prisma.syncedSubscriber.findMany({
      where: { shop },
    });

    let created = 0;

    for (const subscriber of subscribers) {
      // Check if they qualify based on order count
      if (triggerNumbers.includes(subscriber.totalOrdersDelivered)) {
        // Check if gift already exists for this order number
        const existing = await prisma.giftEligibility.findUnique({
          where: {
            shop_subscriptionContractId_orderNumber: {
              shop,
              subscriptionContractId: subscriber.contractId,
              orderNumber: subscriber.totalOrdersDelivered,
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
              orderNumber: subscriber.totalOrdersDelivered,
              giftToken,
              status: "pending",
              expiresAt,
            },
          });
          created++;
        }
      }
    }

    return json({
      success: true,
      message: `Processed subscribers. ${created} new gift eligibilities created.`,
    });
  }

  return json({ success: false, error: "Invalid action" });
};

export default function Gifts() {
  const { settings, eligibilities, shop } = useLoaderData<typeof loader>();
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
  const [emailDelayDays, setEmailDelayDays] = useState(String(settings.emailDelayDays));
  const [eligibleProductIds, setEligibleProductIds] = useState(settings.eligibleProductIds || "");
  const [emailSubject, setEmailSubject] = useState(settings.emailSubject);

  // Manual gift creation state
  const [manualContractId, setManualContractId] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualOrderNumber, setManualOrderNumber] = useState("3");

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge tone="attention">Pending</Badge>;
      case "email_sent":
        return <Badge tone="info">Email Sent</Badge>;
      case "selected":
        return <Badge tone="warning">Selected</Badge>;
      case "applied":
        return <Badge tone="success">Applied</Badge>;
      case "expired":
        return <Badge tone="critical">Expired</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const eligibilityRows = eligibilities.map((e: any) => [
    e.subscriptionContractId,
    e.customerEmail,
    e.customerName || "N/A",
    `Order #${e.orderNumber}`,
    getStatusBadge(e.status),
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
    e.status !== "pending" ? (
      <Button size="slim" tone="critical" onClick={() => handleResetStatus(e.id)}>
        Reset
      </Button>
    ) : "-",
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
            {(actionData as any).giftLink && (
              <Box paddingBlockStart="200">
                <Text as="p" variant="bodySm">
                  Gift Link: <a href={(actionData as any).giftLink} target="_blank" rel="noopener">{(actionData as any).giftLink}</a>
                </Text>
              </Box>
            )}
          </Banner>
        )}

        {(actionData as any)?.error && (
          <Banner tone="critical" onDismiss={() => {}}>
            <Text as="p">{(actionData as any).error}</Text>
          </Banner>
        )}

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
                      helpText="Days to wait after order before sending email"
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

              {/* Process Eligible Card */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Process Eligible Subscribers</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Check synced subscribers and create gift eligibilities for those who qualify.
                  </Text>
                  <Form method="post">
                    <input type="hidden" name="intent" value="processEligible" />
                    <Button submit fullWidth loading={isSubmitting}>
                      Process Now
                    </Button>
                  </Form>
                </BlockStack>
              </Card>

              {/* Manual Gift Creation */}
              <Card>
                <Form method="post">
                  <input type="hidden" name="intent" value="createGiftManually" />
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Create Gift Manually</Text>

                    <TextField
                      label="Subscription Contract ID"
                      name="subscriptionContractId"
                      value={manualContractId}
                      onChange={setManualContractId}
                      autoComplete="off"
                    />

                    <TextField
                      label="Customer Email"
                      name="customerEmail"
                      type="email"
                      value={manualEmail}
                      onChange={setManualEmail}
                      autoComplete="off"
                    />

                    <TextField
                      label="Customer Name"
                      name="customerName"
                      value={manualName}
                      onChange={setManualName}
                      autoComplete="off"
                    />

                    <TextField
                      label="Order Number"
                      name="orderNumber"
                      type="number"
                      value={manualOrderNumber}
                      onChange={setManualOrderNumber}
                      autoComplete="off"
                    />

                    <Button submit variant="secondary" loading={isSubmitting}>
                      Create Gift Link
                    </Button>
                  </BlockStack>
                </Form>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Gift Eligibilities ({eligibilities.length})
                  </Text>
                </InlineStack>

                {eligibilities.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text", "text"]}
                    headings={[
                      "Contract ID",
                      "Email",
                      "Name",
                      "Trigger",
                      "Status",
                      "Selections",
                      "Expires",
                      "Gift Link",
                      "Actions",
                    ]}
                    rows={eligibilityRows}
                  />
                ) : (
                  <Box padding="400">
                    <Text as="p" alignment="center" tone="subdued">
                      No gift eligibilities yet. Sync subscribers and process eligible ones.
                    </Text>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

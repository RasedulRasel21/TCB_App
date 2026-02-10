import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  Form,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  Banner,
  BlockStack,
  Text,
  Box,
  DataTable,
  Badge,
  InlineStack,
  EmptyState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";
import { createAppstleService } from "../services/appstle.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await prisma.appSettings.findUnique({
    where: { shop },
  });

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const pageSize = 20;

  const subscribers = await prisma.syncedSubscriber.findMany({
    where: { shop },
    orderBy: { totalOrdersDelivered: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  const totalCount = await prisma.syncedSubscriber.count({
    where: { shop },
  });

  const lastSync = await prisma.syncLog.findFirst({
    where: { shop },
    orderBy: { syncedAt: "desc" },
  });

  return json({
    hasApiKey: !!settings?.appstleApiKey,
    subscribers: subscribers.map((s) => ({
      id: s.id,
      contractId: s.contractId,
      customerId: s.customerId,
      email: s.customerEmail,
      firstName: s.customerFirstName,
      lastName: s.customerLastName,
      status: s.status,
      totalOrdersDelivered: s.totalOrdersDelivered,
      lastOrderId: s.lastOrderId,
      nextBillingDate: s.nextBillingDate?.toISOString(),
    })),
    totalCount,
    page,
    totalPages: Math.ceil(totalCount / pageSize),
    lastSync: lastSync
      ? {
          syncedAt: lastSync.syncedAt.toISOString(),
          totalFetched: lastSync.totalFetched,
          totalSynced: lastSync.totalSynced,
        }
      : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync") {
    const settings = await prisma.appSettings.findUnique({
      where: { shop },
    });

    if (!settings?.appstleApiKey) {
      return json({
        success: false,
        error: "Please configure your Appstle API key in Settings first",
      });
    }

    try {
      const service = createAppstleService(
        settings.appstleApiKey,
        shop,
        settings.appstleApiUrl
      );

      const result = await service.syncSubscribers({
        minOrdersDelivered: 3,
      });

      await prisma.syncedSubscriber.deleteMany({ where: { shop } });

      for (const contract of result.filteredSubscribers) {
        let subscriptionId = contract.subscriptionContractId;
        if (!subscriptionId && contract.graphSubscriptionContractId) {
          const match = contract.graphSubscriptionContractId.match(/\/(\d+)$/);
          subscriptionId = match ? match[1] : contract.id;
        }
        if (!subscriptionId) {
          subscriptionId = contract.contractId || contract.id;
        }

        const rawContract = contract as any;
        const orderCount = rawContract.totalSuccessfulOrders || 0;
        let lastOrderId = rawContract.orderName || null;
        let lastOrderDate: Date | null = null;

        if (rawContract.lastSuccessfulOrder) {
          try {
            const lastOrder = typeof rawContract.lastSuccessfulOrder === "string"
              ? JSON.parse(rawContract.lastSuccessfulOrder)
              : rawContract.lastSuccessfulOrder;
            if (lastOrder.orderName) lastOrderId = lastOrder.orderName;
            if (lastOrder.orderDate) lastOrderDate = new Date(lastOrder.orderDate);
          } catch {}
        }

        let firstName = contract.customerFirstName;
        let lastName = contract.customerLastName;
        if (!firstName && !lastName && contract.customerName) {
          const nameParts = contract.customerName.split(" ");
          firstName = nameParts[0] || "";
          lastName = nameParts.slice(1).join(" ") || "";
        }

        await prisma.syncedSubscriber.create({
          data: {
            shop,
            contractId: String(subscriptionId),
            appstleInternalId: String(contract.id),
            customerId: String(contract.customerId),
            customerEmail: contract.customerEmail,
            customerFirstName: firstName,
            customerLastName: lastName,
            status: contract.status,
            totalOrdersDelivered: orderCount,
            lastOrderId,
            lastOrderDate,
            nextBillingDate: contract.nextBillingDate
              ? new Date(contract.nextBillingDate)
              : null,
            subscriptionData: JSON.stringify(contract),
          },
        });
      }

      await prisma.syncLog.create({
        data: {
          shop,
          totalFetched: result.totalFetched,
          totalSynced: result.filteredSubscribers.length,
          filterMinOrders: 3,
          status: "success",
        },
      });

      return json({
        success: true,
        message: `Synced ${result.filteredSubscribers.length} subscribers (${result.totalFetched} total fetched, filtered to 3+ orders)`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return json({ success: false, error: `Sync failed: ${errorMessage}` });
    }
  }

  if (intent === "clear") {
    await prisma.syncedSubscriber.deleteMany({
      where: { shop },
    });

    return json({
      success: true,
      message: "All synced subscribers have been cleared",
    });
  }

  return json({ success: false, error: "Invalid action" });
};

export default function Subscribers() {
  const {
    hasApiKey,
    subscribers,
    totalCount,
    page,
    totalPages,
    lastSync,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const getStatusBadge = (status: string) => {
    switch (status.toUpperCase()) {
      case "ACTIVE":
        return <Badge tone="success">Active</Badge>;
      case "PAUSED":
        return <Badge tone="warning">Paused</Badge>;
      case "CANCELLED":
        return <Badge tone="critical">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const tableRows = subscribers.map((sub) => [
    sub.contractId,
    `${sub.firstName || ""} ${sub.lastName || ""}`.trim() || "N/A",
    sub.email || "N/A",
    getStatusBadge(sub.status),
    sub.totalOrdersDelivered.toString(),
    sub.lastOrderId || "N/A",
    sub.nextBillingDate
      ? new Date(sub.nextBillingDate).toLocaleDateString()
      : "N/A",
  ]);

  return (
    <Page
      title="Subscribers"
      backAction={{ content: "Home", url: "/app" }}
    >
      <BlockStack gap="500">
        {actionData?.success && (actionData as any).message && (
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
            Subscribers sync automatically every 6 hours via cron. Only subscribers with 3+ completed orders are synced.
            Use "Sync Now" to trigger a manual sync.
          </Text>
        </Banner>

        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Manual Sync</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Fetch subscribers with 3+ orders from Appstle
              </Text>
            </BlockStack>
            <Form method="post">
              <input type="hidden" name="intent" value="sync" />
              <Button submit variant="primary" disabled={!hasApiKey || isSubmitting} loading={isSubmitting}>
                Sync Now
              </Button>
            </Form>
          </InlineStack>
        </Card>

        {lastSync && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Last Sync</Text>
              <Text as="p" variant="bodySm">
                Date: {new Date(lastSync.syncedAt).toLocaleString()}
              </Text>
              <Text as="p" variant="bodySm">
                Fetched: {lastSync.totalFetched} | Synced: {lastSync.totalSynced}
              </Text>
            </BlockStack>
          </Card>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Synced Subscribers ({totalCount})
                  </Text>
                  {totalCount > 0 && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="clear" />
                      <Button submit variant="plain" tone="critical">
                        Clear All
                      </Button>
                    </Form>
                  )}
                </InlineStack>

                {isSubmitting ? (
                  <Box padding="800">
                    <InlineStack align="center" gap="200">
                      <Text as="p">Processing...</Text>
                    </InlineStack>
                  </Box>
                ) : subscribers.length > 0 ? (
                  <>
                    <DataTable
                      columnContentTypes={[
                        "text",
                        "text",
                        "text",
                        "text",
                        "numeric",
                        "text",
                        "text",
                      ]}
                      headings={[
                        "Subscription ID",
                        "Customer Name",
                        "Email",
                        "Status",
                        "Orders",
                        "Last Order",
                        "Next Billing",
                      ]}
                      rows={tableRows}
                    />

                    {totalPages > 1 && (
                      <InlineStack align="center" gap="200">
                        <Button
                          disabled={page <= 1}
                          url={`/app/subscribers?page=${page - 1}`}
                        >
                          Previous
                        </Button>
                        <Text as="span" variant="bodySm">
                          Page {page} of {totalPages}
                        </Text>
                        <Button
                          disabled={page >= totalPages}
                          url={`/app/subscribers?page=${page + 1}`}
                        >
                          Next
                        </Button>
                      </InlineStack>
                    )}
                  </>
                ) : (
                  <EmptyState
                    heading="No subscribers synced yet"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <Text as="p" variant="bodyMd">
                      Subscribers will be synced automatically by the cron job every 6 hours.
                    </Text>
                  </EmptyState>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

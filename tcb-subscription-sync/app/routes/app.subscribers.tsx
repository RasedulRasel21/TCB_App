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
  useSubmit,
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
  Spinner,
  EmptyState,
  Select,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";
import {
  createAppstleService,
  type SubscriptionContract,
} from "../services/appstle.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const pageSize = 20;

  const settings = await prisma.appSettings.findUnique({
    where: { shop },
  });

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
          filterMinOrders: lastSync.filterMinOrders,
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
    const minOrders = parseInt((formData.get("minOrders") as string) || "0");
    const statusFilter = formData.get("statusFilter") as string;

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

      const statusFilterArray =
        statusFilter && statusFilter !== "ALL" ? [statusFilter] : undefined;

      const result = await service.syncSubscribers({
        minOrdersDelivered: minOrders,
        status: statusFilterArray,
      });

      // Clear existing synced subscribers for this shop
      await prisma.syncedSubscriber.deleteMany({
        where: { shop },
      });

      // Save filtered subscribers
      for (const contract of result.filteredSubscribers) {
        // Use subscriptionContractId as main ID (e.g., 120951144534)
        // Fall back to graphSubscriptionContractId or id
        let subscriptionId = contract.subscriptionContractId;
        if (!subscriptionId && contract.graphSubscriptionContractId) {
          // Extract ID from gid://shopify/SubscriptionContract/120951144534
          const match = contract.graphSubscriptionContractId.match(/\/(\d+)$/);
          subscriptionId = match ? match[1] : contract.id;
        }
        if (!subscriptionId) {
          subscriptionId = contract.contractId || contract.id;
        }

        // Cast to any to access all fields from the API response
        const rawContract = contract as any;

        // Use totalSuccessfulOrders as the order count - this is the correct field!
        let orderCount = rawContract.totalSuccessfulOrders || 0;
        let lastOrderId = rawContract.orderName || null;
        let lastOrderDate: Date | null = null;

        // Parse lastSuccessfulOrder to get the actual last order info
        if (rawContract.lastSuccessfulOrder) {
          try {
            const lastOrder = typeof rawContract.lastSuccessfulOrder === 'string'
              ? JSON.parse(rawContract.lastSuccessfulOrder)
              : rawContract.lastSuccessfulOrder;
            if (lastOrder.orderName) {
              lastOrderId = lastOrder.orderName; // e.g., "#1007"
            }
            if (lastOrder.orderDate) {
              lastOrderDate = new Date(lastOrder.orderDate);
            }
          } catch (e) {
            console.log('Could not parse lastSuccessfulOrder:', e);
          }
        }


        // Extract customer name parts if separate fields not available
        let firstName = contract.customerFirstName;
        let lastName = contract.customerLastName;
        if (!firstName && !lastName && contract.customerName) {
          const nameParts = contract.customerName.split(' ');
          firstName = nameParts[0] || '';
          lastName = nameParts.slice(1).join(' ') || '';
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
            lastOrderId: lastOrderId,
            lastOrderDate: lastOrderDate,
            nextBillingDate: contract.nextBillingDate
              ? new Date(contract.nextBillingDate)
              : null,
            subscriptionData: JSON.stringify(contract),
          },
        });
      }

      // Log the sync
      await prisma.syncLog.create({
        data: {
          shop,
          totalFetched: result.totalFetched,
          totalSynced: result.filteredSubscribers.length,
          filterMinOrders: minOrders,
          status: "success",
        },
      });

      return json({
        success: true,
        message: `Successfully synced ${result.filteredSubscribers.length} subscribers (${result.totalFetched} total fetched, filtered by ${minOrders}+ orders)`,
        totalFetched: result.totalFetched,
        totalSynced: result.filteredSubscribers.length,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";

      // Log the failed sync
      await prisma.syncLog.create({
        data: {
          shop,
          totalFetched: 0,
          totalSynced: 0,
          filterMinOrders: minOrders,
          status: "failed",
          errorMessage,
        },
      });

      return json({
        success: false,
        error: `Sync failed: ${errorMessage}`,
      });
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
  const submit = useSubmit();

  const [minOrders, setMinOrders] = useState("0");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const isSubmitting = navigation.state === "submitting";

  const handleMinOrdersChange = useCallback(
    (value: string) => setMinOrders(value),
    []
  );
  const handleStatusChange = useCallback(
    (value: string) => setStatusFilter(value),
    []
  );

  const statusOptions = [
    { label: "All Statuses", value: "ALL" },
    { label: "Active", value: "ACTIVE" },
    { label: "Paused", value: "PAUSED" },
    { label: "Cancelled", value: "CANCELLED" },
  ];

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
      primaryAction={{
        content: "Sync Subscribers",
        disabled: !hasApiKey || isSubmitting,
        loading: isSubmitting,
        onAction: () => {
          const formData = new FormData();
          formData.append("intent", "sync");
          formData.append("minOrders", minOrders);
          formData.append("statusFilter", statusFilter);
          submit(formData, { method: "post" });
        },
      }}
    >
      <BlockStack gap="500">
        {!hasApiKey && (
          <Banner
            title="API Key Required"
            tone="warning"
            action={{ content: "Go to Settings", url: "/app/settings" }}
          >
            <Text as="p">
              Please configure your Appstle API key in Settings before syncing
              subscribers.
            </Text>
          </Banner>
        )}

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

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Sync Filters
                </Text>

                <FormLayout>
                  <TextField
                    label="Minimum Orders Delivered"
                    type="number"
                    value={minOrders}
                    onChange={handleMinOrdersChange}
                    helpText="Only sync subscribers with at least this many orders delivered"
                    min={0}
                    autoComplete="off"
                  />

                  <Select
                    label="Subscription Status"
                    options={statusOptions}
                    value={statusFilter}
                    onChange={handleStatusChange}
                    helpText="Filter by subscription status"
                  />
                </FormLayout>

                <Box>
                  <Form method="post">
                    <input type="hidden" name="intent" value="sync" />
                    <input type="hidden" name="minOrders" value={minOrders} />
                    <input type="hidden" name="statusFilter" value={statusFilter} />
                    <Button
                      submit
                      variant="primary"
                      disabled={!hasApiKey || isSubmitting}
                      loading={isSubmitting}
                      fullWidth
                    >
                      {isSubmitting ? "Syncing..." : "Sync Subscribers"}
                    </Button>
                  </Form>
                </Box>

                {lastSync && (
                  <Box
                    background="bg-surface-secondary"
                    padding="300"
                    borderRadius="200"
                  >
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        Last Sync Info
                      </Text>
                      <Text as="p" variant="bodySm">
                        Date: {new Date(lastSync.syncedAt).toLocaleString()}
                      </Text>
                      <Text as="p" variant="bodySm">
                        Fetched: {lastSync.totalFetched}
                      </Text>
                      <Text as="p" variant="bodySm">
                        Synced: {lastSync.totalSynced}
                      </Text>
                      <Text as="p" variant="bodySm">
                        Min Orders Filter: {lastSync.filterMinOrders}
                      </Text>
                    </BlockStack>
                  </Box>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

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
                      <Spinner size="small" />
                      <Text as="p">Syncing subscribers from Appstle...</Text>
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
                      Set your filter criteria and click "Sync Subscribers" to
                      fetch subscribers from Appstle.
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

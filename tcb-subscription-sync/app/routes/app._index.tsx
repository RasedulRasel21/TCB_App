import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Banner,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Get app settings
  const settings = await prisma.appSettings.findUnique({
    where: { shop },
  });

  // Get sync stats
  const subscriberCount = await prisma.syncedSubscriber.count({
    where: { shop },
  });

  const lastSync = await prisma.syncLog.findFirst({
    where: { shop },
    orderBy: { syncedAt: "desc" },
  });

  return json({
    hasApiKey: !!settings?.appstleApiKey,
    subscriberCount,
    lastSync: lastSync
      ? {
          syncedAt: lastSync.syncedAt.toISOString(),
          totalSynced: lastSync.totalSynced,
          filterMinOrders: lastSync.filterMinOrders,
          status: lastSync.status,
        }
      : null,
  });
};

export default function Index() {
  const { hasApiKey, subscriberCount, lastSync } = useLoaderData<typeof loader>();

  return (
    <Page title="TCB Subscription Sync">
      <BlockStack gap="500">
        {!hasApiKey && (
          <Banner
            title="Setup Required"
            tone="warning"
            action={{ content: "Go to Settings", url: "/app/settings" }}
          >
            <Text as="p">
              Please configure your Appstle API key in the settings to start syncing
              subscribers.
            </Text>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Synced Subscribers
                </Text>
                <Text as="p" variant="headingXl">
                  {subscriberCount}
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Total subscribers synced from Appstle
                </Text>
                <Box>
                  <Link to="/app/subscribers">
                    <Button>View Subscribers</Button>
                  </Link>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Last Sync
                </Text>
                {lastSync ? (
                  <>
                    <Text as="p" variant="bodyMd">
                      <strong>Date:</strong>{" "}
                      {new Date(lastSync.syncedAt).toLocaleString()}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      <strong>Synced:</strong> {lastSync.totalSynced}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      <strong>Status:</strong>{" "}
                      <Text
                        as="span"
                        tone={lastSync.status === "success" ? "success" : "critical"}
                      >
                        {lastSync.status}
                      </Text>
                    </Text>
                  </>
                ) : (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No sync yet
                  </Text>
                )}
                <Box>
                  <Link to="/app/subscribers">
                    <Button variant="primary" disabled={!hasApiKey}>
                      Sync Now
                    </Button>
                  </Link>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Gift Management
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Reward loyal subscribers with free products on milestone orders
                </Text>
                <Box>
                  <Link to="/app/gifts">
                    <Button>Manage Gifts</Button>
                  </Link>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Quick Start Guide
            </Text>
            <BlockStack gap="200">
              <InlineStack gap="200" align="start">
                <Text as="span" variant="bodyMd" fontWeight="bold">
                  1.
                </Text>
                <Text as="span" variant="bodyMd">
                  Configure your Appstle API key in{" "}
                  <Link to="/app/settings">Settings</Link>
                </Text>
              </InlineStack>
              <InlineStack gap="200" align="start">
                <Text as="span" variant="bodyMd" fontWeight="bold">
                  2.
                </Text>
                <Text as="span" variant="bodyMd">
                  Go to the <Link to="/app/subscribers">Subscribers</Link> page
                </Text>
              </InlineStack>
              <InlineStack gap="200" align="start">
                <Text as="span" variant="bodyMd" fontWeight="bold">
                  3.
                </Text>
                <Text as="span" variant="bodyMd">
                  Set the minimum orders filter (e.g., 3 to sync subscribers with
                  3+ orders)
                </Text>
              </InlineStack>
              <InlineStack gap="200" align="start">
                <Text as="span" variant="bodyMd" fontWeight="bold">
                  4.
                </Text>
                <Text as="span" variant="bodyMd">
                  Click "Sync Subscribers" to fetch and store filtered subscribers
                </Text>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

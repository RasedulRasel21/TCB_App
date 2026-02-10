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

  const settings = await prisma.appSettings.findUnique({
    where: { shop },
  });

  const subscriberCount = await prisma.syncedSubscriber.count({
    where: { shop },
  });

  const eligibilityCount = await prisma.giftEligibility.count({
    where: { shop },
  });

  const lastSync = await prisma.syncLog.findFirst({
    where: { shop },
    orderBy: { syncedAt: "desc" },
  });

  const giftSettings = await prisma.giftSettings.findUnique({
    where: { shop },
  });

  // Build the cron URL from the request
  const url = new URL(request.url);
  const appOrigin = url.origin;

  return json({
    hasApiKey: !!settings?.appstleApiKey,
    subscriberCount,
    eligibilityCount,
    giftEnabled: giftSettings?.enabled ?? false,
    lastSync: lastSync
      ? {
          syncedAt: lastSync.syncedAt.toISOString(),
          totalSynced: lastSync.totalSynced,
          status: lastSync.status,
        }
      : null,
    cronUrl: `${appOrigin}/api/cron`,
  });
};

export default function Index() {
  const { hasApiKey, subscriberCount, eligibilityCount, giftEnabled, lastSync, cronUrl } =
    useLoaderData<typeof loader>();

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
              Please configure your Appstle API key in the settings to get started.
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
                  Auto-synced from Appstle (3+ orders)
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
                  Gift Eligibilities
                </Text>
                <Text as="p" variant="headingXl">
                  {eligibilityCount}
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {giftEnabled ? "Gift system enabled" : "Gift system disabled"}
                </Text>
                <Box>
                  <Link to="/app/gifts">
                    <Button>Manage Gifts</Button>
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
                      {new Date(lastSync.syncedAt).toLocaleString()}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Synced: {lastSync.totalSynced} subscribers
                    </Text>
                    <Text
                      as="p"
                      variant="bodyMd"
                      tone={lastSync.status === "success" ? "success" : "critical"}
                    >
                      Status: {lastSync.status}
                    </Text>
                  </>
                ) : (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No sync yet. Cron will run automatically.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Automated Flow
            </Text>
            <BlockStack gap="200">
              <InlineStack gap="200" align="start">
                <Text as="span" variant="bodyMd" fontWeight="bold">1.</Text>
                <Text as="span" variant="bodyMd">
                  Configure your Appstle API key in{" "}
                  <Link to="/app/settings">Settings</Link>
                </Text>
              </InlineStack>
              <InlineStack gap="200" align="start">
                <Text as="span" variant="bodyMd" fontWeight="bold">2.</Text>
                <Text as="span" variant="bodyMd">
                  Configure gift milestones and email settings in{" "}
                  <Link to="/app/gifts">Gift Management</Link>
                </Text>
              </InlineStack>
              <InlineStack gap="200" align="start">
                <Text as="span" variant="bodyMd" fontWeight="bold">3.</Text>
                <Text as="span" variant="bodyMd">
                  Everything runs automatically every 6 hours: subscriber sync, eligibility processing, and email sending
                </Text>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Auto-Sync Schedule
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              The built-in scheduler runs every 6 hours automatically (and once on app startup).
              It syncs subscribers from Appstle, creates gift eligibilities for milestone orders,
              and sends pending emails. You can also trigger a manual sync from the{" "}
              <Link to="/app/subscribers">Subscribers</Link> or{" "}
              <Link to="/app/gifts">Gift Management</Link> pages.
            </Text>
            <Box
              background="bg-surface-secondary"
              padding="300"
              borderRadius="200"
            >
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                POST {cronUrl}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Optional: You can also call this endpoint externally if needed.
              </Text>
            </Box>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

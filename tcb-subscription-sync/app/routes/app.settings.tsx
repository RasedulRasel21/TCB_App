import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, Form } from "@remix-run/react";
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
} from "@shopify/polaris";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";
import { createAppstleService } from "../services/appstle.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await prisma.appSettings.findUnique({
    where: { shop },
  });

  return json({
    apiKey: settings?.appstleApiKey ? "••••••••" + settings.appstleApiKey.slice(-8) : "",
    apiUrl: settings?.appstleApiUrl || "https://subscription-admin.appstle.com",
    hasApiKey: !!settings?.appstleApiKey,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save") {
    const apiKey = formData.get("apiKey") as string;
    const apiUrl = (formData.get("apiUrl") as string) || "https://subscription-admin.appstle.com";

    if (!apiKey || apiKey.startsWith("••••")) {
      return json({
        success: false,
        error: "Please enter a valid API key",
      });
    }

    await prisma.appSettings.upsert({
      where: { shop },
      create: {
        shop,
        appstleApiKey: apiKey,
        appstleApiUrl: apiUrl,
      },
      update: {
        appstleApiKey: apiKey,
        appstleApiUrl: apiUrl,
      },
    });

    return json({
      success: true,
      message: "Settings saved successfully",
    });
  }

  if (intent === "test") {
    const settings = await prisma.appSettings.findUnique({
      where: { shop },
    });

    if (!settings?.appstleApiKey) {
      return json({
        success: false,
        error: "Please save your API key first",
      });
    }

    const service = createAppstleService(
      settings.appstleApiKey,
      shop,
      settings.appstleApiUrl
    );

    const result = await service.testConnection();

    return json({
      success: result.success,
      message: result.message,
      error: result.success ? undefined : result.message,
    });
  }

  return json({ success: false, error: "Invalid action" });
};

export default function Settings() {
  const { apiKey: savedApiKey, apiUrl: savedApiUrl, hasApiKey } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  const [apiKey, setApiKey] = useState(savedApiKey);
  const [apiUrl, setApiUrl] = useState(savedApiUrl);

  const isSubmitting = navigation.state === "submitting";

  const handleApiKeyChange = useCallback((value: string) => setApiKey(value), []);
  const handleApiUrlChange = useCallback((value: string) => setApiUrl(value), []);

  useEffect(() => {
    if (savedApiKey) setApiKey(savedApiKey);
    if (savedApiUrl) setApiUrl(savedApiUrl);
  }, [savedApiKey, savedApiUrl]);

  return (
    <Page
      title="Settings"
      backAction={{ content: "Home", url: "/app" }}
    >
      <BlockStack gap="500">
        {actionData?.success && actionData.message && (
          <Banner tone="success" onDismiss={() => {}}>
            <Text as="p">{actionData.message}</Text>
          </Banner>
        )}

        {actionData?.error && (
          <Banner tone="critical" onDismiss={() => {}}>
            <Text as="p">{actionData.error}</Text>
          </Banner>
        )}

        <Layout>
          <Layout.AnnotatedSection
            title="Appstle API Configuration"
            description="Enter your Appstle Subscription API credentials to enable subscriber syncing."
          >
            <Card>
              <Form method="post">
                <input type="hidden" name="intent" value="save" />
                <BlockStack gap="400">
                  <FormLayout>
                    <TextField
                      label="API Key"
                      name="apiKey"
                      type="password"
                      value={apiKey}
                      onChange={handleApiKeyChange}
                      helpText="Your Appstle API key. You can find this in your Appstle app settings."
                      autoComplete="off"
                    />

                    <TextField
                      label="API URL"
                      name="apiUrl"
                      value={apiUrl}
                      onChange={handleApiUrlChange}
                      helpText="The Appstle API base URL. Usually you don't need to change this."
                      autoComplete="off"
                    />
                  </FormLayout>

                  <Box>
                    <Button submit variant="primary" loading={isSubmitting}>
                      Save Settings
                    </Button>
                  </Box>
                </BlockStack>
              </Form>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Test Connection"
            description="Test your API connection to ensure everything is configured correctly."
          >
            <Card>
              <Form method="post">
                <input type="hidden" name="intent" value="test" />
                <BlockStack gap="400">
                  <Text as="p" variant="bodyMd">
                    Click the button below to test your connection to the Appstle API.
                  </Text>
                  <Box>
                    <Button
                      submit
                      loading={isSubmitting}
                      disabled={!hasApiKey}
                    >
                      Test Connection
                    </Button>
                  </Box>
                </BlockStack>
              </Form>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Getting Your API Key"
            description="How to find your Appstle API credentials."
          >
            <Card>
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd">
                  To get your Appstle API key:
                </Text>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    1. Log in to your Shopify admin
                  </Text>
                  <Text as="p" variant="bodyMd">
                    2. Open the Appstle Subscriptions app
                  </Text>
                  <Text as="p" variant="bodyMd">
                    3. Go to Settings → API / Integrations
                  </Text>
                  <Text as="p" variant="bodyMd">
                    4. Copy your API key from there
                  </Text>
                </BlockStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  If you don't see the API settings, you may need to contact Appstle
                  support to enable API access for your account.
                </Text>
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </BlockStack>
    </Page>
  );
}

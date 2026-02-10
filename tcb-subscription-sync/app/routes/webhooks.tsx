import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";
import { randomBytes } from "crypto";
import { createAppstleService } from "../services/appstle.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

  if (!admin) {
    throw new Response();
  }

  switch (topic) {
    case "APP_UNINSTALLED":
      if (session) {
        await prisma.session.deleteMany({ where: { shop } });
        await prisma.appSettings.deleteMany({ where: { shop } });
        await prisma.syncedSubscriber.deleteMany({ where: { shop } });
        await prisma.syncLog.deleteMany({ where: { shop } });
      }
      break;

    case "ORDERS_PAID":
      await handleOrderPaid(shop, payload);
      break;

    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
      break;

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};

/**
 * Handle ORDERS_PAID webhook
 * Checks if this is a subscription order and if the customer has hit a gift trigger milestone
 */
async function handleOrderPaid(shop: string, payload: any) {
  try {
    console.log(`[Webhook] ORDERS_PAID received for shop ${shop}`);

    const customerId = payload.customer?.id;
    const customerEmail = payload.customer?.email;
    const customerName = [payload.customer?.first_name, payload.customer?.last_name]
      .filter(Boolean)
      .join(" ");

    if (!customerId || !customerEmail) {
      console.log("[Webhook] No customer info in order, skipping");
      return;
    }

    // Check if gift system is enabled
    const giftSettings = await prisma.giftSettings.findUnique({
      where: { shop },
    });

    if (!giftSettings?.enabled) {
      console.log("[Webhook] Gift system disabled, skipping");
      return;
    }

    const triggerNumbers = giftSettings.triggerOrderNumbers
      .split(",")
      .map((n) => parseInt(n.trim()))
      .filter((n) => !isNaN(n));

    if (triggerNumbers.length === 0) {
      console.log("[Webhook] No trigger order numbers configured, skipping");
      return;
    }

    // Get Appstle API settings
    const appSettings = await prisma.appSettings.findUnique({
      where: { shop },
    });

    if (!appSettings?.appstleApiKey) {
      console.log("[Webhook] No Appstle API key configured, skipping");
      return;
    }

    // Use Appstle API to check actual completed order count
    const service = createAppstleService(
      appSettings.appstleApiKey,
      shop,
      appSettings.appstleApiUrl
    );

    const pastOrders = await service.getPastOrders(String(customerId));
    const completedOrders = pastOrders.totalSuccessOrders;

    console.log(`[Webhook] Customer ${customerEmail} has ${completedOrders} completed orders`);

    // Check if this order count hits a trigger number
    if (!triggerNumbers.includes(completedOrders)) {
      console.log(`[Webhook] ${completedOrders} orders doesn't match triggers [${triggerNumbers.join(",")}], skipping`);
      return;
    }

    console.log(`[Webhook] Customer hit trigger: ${completedOrders} orders!`);

    // Find the customer's subscription contract
    const subscriber = await prisma.syncedSubscriber.findFirst({
      where: {
        shop,
        customerId: String(customerId),
      },
    });

    const subscriptionContractId = subscriber?.contractId || `order-${payload.id}`;

    // Check if gift eligibility already exists for this milestone
    const existing = await prisma.giftEligibility.findUnique({
      where: {
        shop_subscriptionContractId_orderNumber: {
          shop,
          subscriptionContractId,
          orderNumber: completedOrders,
        },
      },
    });

    if (existing) {
      console.log(`[Webhook] Gift eligibility already exists for order #${completedOrders}, skipping`);
      return;
    }

    // Create gift eligibility
    const giftToken = randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + giftSettings.giftExpiryDays);

    const eligibility = await prisma.giftEligibility.create({
      data: {
        shop,
        subscriptionContractId,
        customerId: String(customerId),
        customerEmail,
        customerName,
        orderNumber: completedOrders,
        giftToken,
        status: "pending",
        expiresAt,
      },
    });

    console.log(`[Webhook] Gift eligibility created for ${customerEmail} at order #${completedOrders}.`);

    // If emailDelayDays is 0, send email immediately
    if (giftSettings.emailDelayDays === 0) {
      try {
        const service = createAppstleService(
          appSettings.appstleApiKey,
          shop,
          appSettings.appstleApiUrl
        );

        const emailResult = await service.sendMagicLinkEmail(customerEmail);

        if (emailResult.success) {
          await prisma.giftEligibility.update({
            where: { id: eligibility.id },
            data: {
              status: "email_sent",
              emailSentAt: new Date(),
            },
          });
          console.log(`[Webhook] Email sent immediately to ${customerEmail} (delay=0)`);
        } else {
          console.log(`[Webhook] Failed to send email to ${customerEmail}: ${emailResult.message}`);
        }
      } catch (emailError) {
        console.error("[Webhook] Error sending immediate email:", emailError);
      }
    } else {
      console.log(`[Webhook] Email will be sent after ${giftSettings.emailDelayDays} days (via cron).`);
    }
  } catch (error) {
    console.error("[Webhook] Error handling ORDERS_PAID:", error);
  }
}

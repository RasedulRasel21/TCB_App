import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { prisma } from "../db.server";
import { createAppstleService } from "../services/appstle.server";
import { randomBytes } from "crypto";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Unified cron endpoint: POST /api/cron
 *
 * Called by an external cron service every 6 hours.
 * For each shop with gift settings enabled:
 *   1. Sync subscribers from Appstle (min 3 orders)
 *   2. Process eligible subscribers → create GiftEligibility records
 *   3. Send emails for pending eligibilities past the delay period
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return json({ message: "POST /api/cron to trigger cron job" }, { headers: corsHeaders });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const results: Array<{
    shop: string;
    subscribersSynced: number;
    eligibilitiesCreated: number;
    emailsSent: number;
    emailsFailed: number;
    errors: string[];
  }> = [];

  try {
    // Get all shops with gift settings enabled
    const giftSettingsList = await prisma.giftSettings.findMany({
      where: { enabled: true },
    });

    for (const giftSettings of giftSettingsList) {
      const shop = giftSettings.shop;
      const shopResult = {
        shop,
        subscribersSynced: 0,
        eligibilitiesCreated: 0,
        emailsSent: 0,
        emailsFailed: 0,
        errors: [] as string[],
      };

      try {
        // Get app settings for API key
        const appSettings = await prisma.appSettings.findUnique({
          where: { shop },
        });

        if (!appSettings?.appstleApiKey) {
          shopResult.errors.push("No Appstle API key configured");
          results.push(shopResult);
          continue;
        }

        const service = createAppstleService(
          appSettings.appstleApiKey,
          shop,
          appSettings.appstleApiUrl
        );

        // --- Step 1: Sync subscribers (min 3 orders) ---
        try {
          const syncResult = await service.syncSubscribers({
            minOrdersDelivered: 3,
          });

          // Clear and re-sync
          await prisma.syncedSubscriber.deleteMany({ where: { shop } });

          for (const contract of syncResult.filteredSubscribers) {
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

          shopResult.subscribersSynced = syncResult.filteredSubscribers.length;

          // Log the sync
          await prisma.syncLog.create({
            data: {
              shop,
              totalFetched: syncResult.totalFetched,
              totalSynced: syncResult.filteredSubscribers.length,
              filterMinOrders: 3,
              status: "success",
            },
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown sync error";
          shopResult.errors.push(`Sync failed: ${msg}`);
        }

        // --- Step 2: Process eligible subscribers → create GiftEligibility records ---
        try {
          const triggerNumbers = giftSettings.triggerOrderNumbers
            .split(",")
            .map((n) => parseInt(n.trim()))
            .filter((n) => !isNaN(n));

          const subscribers = await prisma.syncedSubscriber.findMany({
            where: { shop },
          });

          for (const subscriber of subscribers) {
            if (triggerNumbers.includes(subscriber.totalOrdersDelivered)) {
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
                expiresAt.setDate(expiresAt.getDate() + giftSettings.giftExpiryDays);

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
                shopResult.eligibilitiesCreated++;
              }
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown processing error";
          shopResult.errors.push(`Process eligible failed: ${msg}`);
        }

        // --- Step 3: Send emails for pending eligibilities past the delay period ---
        try {
          const emailDelayDays = giftSettings.emailDelayDays || 0;
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

          // Mark ALL as email_sent with timestamp BEFORE calling API
          // This prevents any other process from picking them up
          const eligibilityIds = pendingEligibilities.map((e) => e.id);
          if (eligibilityIds.length > 0) {
            await prisma.giftEligibility.updateMany({
              where: { id: { in: eligibilityIds } },
              data: { status: "email_sent", emailSentAt: new Date() },
            });
          }

          for (const eligibility of pendingEligibilities) {
            try {
              const emailResult = await service.sendMagicLinkEmail(eligibility.customerEmail);

              if (emailResult.success) {
                shopResult.emailsSent++;
              } else {
                // Mark as failed, do NOT revert to pending
                await prisma.giftEligibility.update({
                  where: { id: eligibility.id },
                  data: { status: "email_failed" },
                });
                shopResult.emailsFailed++;
              }

              // Rate limit
              await new Promise((resolve) => setTimeout(resolve, 500));
            } catch {
              await prisma.giftEligibility.update({
                where: { id: eligibility.id },
                data: { status: "email_failed" },
              });
              shopResult.emailsFailed++;
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown email error";
          shopResult.errors.push(`Email sending failed: ${msg}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown shop error";
        shopResult.errors.push(msg);
      }

      results.push(shopResult);
    }

    return json(
      {
        success: true,
        timestamp: new Date().toISOString(),
        shopsProcessed: results.length,
        results,
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Cron job failed",
      },
      { status: 500, headers: corsHeaders }
    );
  }
};

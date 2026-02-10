import cron from "node-cron";
import { prisma } from "./db.server";
import { createAppstleService } from "./services/appstle.server";
import { randomBytes } from "crypto";

declare global {
  var __cronTask: ReturnType<typeof cron.schedule> | undefined;
  var __cronRunning: boolean | undefined;
}

// Run the cron job logic for all shops with gift settings enabled.
async function runCronJob() {
  // Prevent overlapping runs
  if (global.__cronRunning) {
    console.log("[Cron] Skipping - previous run still in progress");
    return;
  }
  global.__cronRunning = true;

  console.log(`[Cron] Starting scheduled sync at ${new Date().toISOString()}`);

  try {
    const giftSettingsList = await prisma.giftSettings.findMany({
      where: { enabled: true },
    });

    for (const giftSettings of giftSettingsList) {
      const shop = giftSettings.shop;
      console.log(`[Cron] Processing shop: ${shop}`);

      try {
        const appSettings = await prisma.appSettings.findUnique({
          where: { shop },
        });

        if (!appSettings?.appstleApiKey) {
          console.log(`[Cron] No API key for ${shop}, skipping`);
          continue;
        }

        const service = createAppstleService(
          appSettings.appstleApiKey,
          shop,
          appSettings.appstleApiUrl
        );

        // Step 1: Sync subscribers (min 3 orders)
        try {
          const syncResult = await service.syncSubscribers({
            minOrdersDelivered: 3,
          });

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
                const lastOrder =
                  typeof rawContract.lastSuccessfulOrder === "string"
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
              totalFetched: syncResult.totalFetched,
              totalSynced: syncResult.filteredSubscribers.length,
              filterMinOrders: 3,
              status: "success",
            },
          });

          console.log(
            `[Cron] ${shop}: Synced ${syncResult.filteredSubscribers.length} subscribers`
          );
        } catch (error) {
          console.error(`[Cron] ${shop}: Sync failed:`, error);
        }

        // Step 2: Process eligible subscribers
        try {
          const triggerNumbers = giftSettings.triggerOrderNumbers
            .split(",")
            .map((n) => parseInt(n.trim()))
            .filter((n) => !isNaN(n));

          const subscribers = await prisma.syncedSubscriber.findMany({
            where: { shop },
          });

          let created = 0;

          for (const subscriber of subscribers) {
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
                  expiresAt.setDate(expiresAt.getDate() + giftSettings.giftExpiryDays);

                  await prisma.giftEligibility.create({
                    data: {
                      shop,
                      subscriptionContractId: subscriber.contractId,
                      customerId: subscriber.customerId,
                      customerEmail: subscriber.customerEmail || "",
                      customerName:
                        `${subscriber.customerFirstName || ""} ${subscriber.customerLastName || ""}`.trim(),
                      orderNumber: trigger,
                      giftToken,
                      status: "pending",
                      expiresAt,
                    },
                  });
                  created++;
                }
              }
            }
          }

          console.log(`[Cron] ${shop}: Created ${created} new eligibilities`);
        } catch (error) {
          console.error(`[Cron] ${shop}: Process eligible failed:`, error);
        }

        // Step 3: Send emails ONLY for eligibilities that have NEVER been emailed
        // Key guard: emailSentAt IS NULL ensures we never send twice
        try {
          const emailDelayDays = giftSettings.emailDelayDays || 0;
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - emailDelayDays);

          const pendingEligibilities = await prisma.giftEligibility.findMany({
            where: {
              shop,
              status: "pending",
              emailSentAt: null, // NEVER been emailed before
              createdAt: { lte: cutoffDate },
              expiresAt: { gt: new Date() },
            },
          });

          if (pendingEligibilities.length === 0) {
            console.log(`[Cron] ${shop}: No pending emails to send`);
          } else {
            // Immediately mark ALL as email_sent with timestamp BEFORE calling API
            // This is the lock - even if API call is slow, next cron run won't pick these up
            const ids = pendingEligibilities.map((e) => e.id);
            await prisma.giftEligibility.updateMany({
              where: { id: { in: ids } },
              data: {
                status: "email_sent",
                emailSentAt: new Date(),
              },
            });

            let sent = 0;
            let failed = 0;

            for (const eligibility of pendingEligibilities) {
              try {
                const emailResult = await service.sendMagicLinkEmail(
                  eligibility.customerEmail
                );

                if (emailResult.success) {
                  sent++;
                  console.log(`[Cron] ${shop}: Email sent to ${eligibility.customerEmail}`);
                } else {
                  failed++;
                  // Mark as failed - do NOT revert to pending
                  await prisma.giftEligibility.update({
                    where: { id: eligibility.id },
                    data: { status: "email_failed" },
                  });
                  console.log(`[Cron] ${shop}: Email failed for ${eligibility.customerEmail}: ${emailResult.message}`);
                }

                await new Promise((resolve) => setTimeout(resolve, 500));
              } catch (err) {
                failed++;
                await prisma.giftEligibility.update({
                  where: { id: eligibility.id },
                  data: { status: "email_failed" },
                });
                console.error(`[Cron] ${shop}: Email error for ${eligibility.customerEmail}:`, err);
              }
            }

            console.log(
              `[Cron] ${shop}: Emails done - ${sent} sent, ${failed} failed`
            );
          }
        } catch (error) {
          console.error(`[Cron] ${shop}: Email sending failed:`, error);
        }
      } catch (error) {
        console.error(`[Cron] ${shop}: Shop processing failed:`, error);
      }
    }

    console.log(`[Cron] Completed at ${new Date().toISOString()}`);
  } catch (error) {
    console.error("[Cron] Fatal error:", error);
  } finally {
    global.__cronRunning = false;
  }
}

// Initialize the cron scheduler. Only runs once per process.
// Stops any previous scheduler from HMR reloads before creating a new one.
export function initCron() {
  // Stop previous scheduler if it exists (handles HMR reloads)
  if (global.__cronTask) {
    global.__cronTask.stop();
    console.log("[Cron] Stopped previous scheduler (HMR reload)");
  }

  // TESTING: Run every 30 seconds. Change back to "0 */6 * * *" for production.
  global.__cronTask = cron.schedule("*/30 * * * * *", () => {
    runCronJob().catch((err) => console.error("[Cron] Unhandled error:", err));
  });

  console.log("[Cron] Scheduler initialized - TESTING MODE: runs every 30 seconds");

  // Run once on startup after a 30-second delay
  setTimeout(() => {
    console.log("[Cron] Running initial sync on startup...");
    runCronJob().catch((err) => console.error("[Cron] Startup run error:", err));
  }, 30000);
}

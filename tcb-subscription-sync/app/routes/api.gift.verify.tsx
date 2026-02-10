import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { prisma } from "../db.server";

/**
 * API endpoint to verify a gift token
 * GET /api/gift/verify?token=xxx
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const email = url.searchParams.get("email");

  // CORS headers for cross-origin requests from storefront
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (!token && !email) {
    return json({ valid: false, message: "No token or email provided" }, { headers });
  }

  try {
    // Look up by token or by email (find the latest pending/email_sent eligibility)
    let eligibility;
    if (token) {
      eligibility = await prisma.giftEligibility.findUnique({
        where: { giftToken: token },
        include: { selections: true },
      });
    } else if (email) {
      eligibility = await prisma.giftEligibility.findFirst({
        where: {
          customerEmail: email,
          status: { in: ["pending", "email_sent"] },
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
        include: { selections: true },
      });
    }

    if (!eligibility) {
      // If searched by email, check if there's an already-claimed one
      if (email) {
        const claimed = await prisma.giftEligibility.findFirst({
          where: {
            customerEmail: email,
            status: { in: ["selected", "applied"] },
          },
          orderBy: { createdAt: "desc" },
        });
        if (claimed) {
          return json({ valid: false, message: "You have already selected your free gifts for this milestone!" }, { headers });
        }
        return json({ valid: false, message: "No active gift found for this email. You may not be eligible yet, or your gift has expired." }, { headers });
      }
      return json({ valid: false, message: "Invalid gift token" }, { headers });
    }

    // Check if expired
    if (new Date() > eligibility.expiresAt) {
      return json({ valid: false, message: "This gift link has expired" }, { headers });
    }

    // Check if already selected
    if (eligibility.status === "selected" || eligibility.status === "applied") {
      return json({
        valid: false,
        message: "You have already selected your free gifts",
      }, { headers });
    }

    // Get gift settings for this shop
    const settings = await prisma.giftSettings.findUnique({
      where: { shop: eligibility.shop },
    });

    // Parse eligible product IDs if set
    let eligibleProductIds: string[] | null = null;
    if (settings?.eligibleProductIds) {
      eligibleProductIds = settings.eligibleProductIds.split(",").map(id => id.trim());
    }

    return json({
      valid: true,
      token: eligibility.giftToken, // Return token so gift page can use it for selection
      customerName: eligibility.customerName,
      orderNumber: eligibility.orderNumber,
      maxGifts: settings?.maxGiftProducts || 3,
      eligibleProductIds,
      expiresAt: eligibility.expiresAt.toISOString(),
    }, { headers });

  } catch (error) {
    console.error("Error verifying gift token:", error);
    return json({
      valid: false,
      message: "An error occurred. Please try again.",
    }, { headers, status: 500 });
  }
};

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { prisma } from "../db.server";

/**
 * API endpoint to verify a gift token
 * GET /api/gift/verify?token=xxx
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  // CORS headers for cross-origin requests from storefront
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (!token) {
    return json({ valid: false, message: "No token provided" }, { headers });
  }

  try {
    const eligibility = await prisma.giftEligibility.findUnique({
      where: { giftToken: token },
      include: { selections: true },
    });

    if (!eligibility) {
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

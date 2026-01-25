import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { prisma } from "../db.server";
import { createAppstleService } from "../services/appstle.server";

// CORS headers for cross-origin requests from storefront
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
  "Access-Control-Max-Age": "86400",
};

/**
 * Handle GET and OPTIONS requests
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Always return CORS headers
  return new Response(
    JSON.stringify({ message: "Use POST to submit gift selections" }),
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    }
  );
};

/**
 * Handle OPTIONS preflight - Remix routes OPTIONS to action for non-GET
 */
export const options = async () => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
};

/**
 * API endpoint to submit gift selections
 * POST /api/gift/select
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Handle preflight OPTIONS request
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  console.log("Gift select API called, method:", request.method);

  try {
    const body = await request.json();
    console.log("Request body:", body);

    const { token, products } = body as {
      token: string;
      products: Array<{ variantId: string; title: string }>;
    };

    if (!token || !products || products.length === 0) {
      console.log("Invalid request - missing token or products");
      return json({ success: false, error: "Invalid request - missing token or products" }, { headers: corsHeaders, status: 400 });
    }

    // Find eligibility
    const eligibility = await prisma.giftEligibility.findUnique({
      where: { giftToken: token },
    });

    if (!eligibility) {
      console.log("Gift token not found:", token);
      return json({ success: false, error: "Invalid gift token. Please use the link from your email." }, { headers: corsHeaders, status: 400 });
    }

    console.log("Found eligibility:", eligibility.id);

    // Check if expired
    if (new Date() > eligibility.expiresAt) {
      return json({ success: false, error: "This gift link has expired" }, { headers: corsHeaders, status: 400 });
    }

    // Check if already selected
    if (eligibility.status === "selected" || eligibility.status === "applied") {
      return json({
        success: false,
        error: "You have already selected your free gifts",
      }, { headers: corsHeaders, status: 400 });
    }

    // Get settings
    const settings = await prisma.giftSettings.findUnique({
      where: { shop: eligibility.shop },
    });

    const maxGifts = settings?.maxGiftProducts || 3;

    if (products.length > maxGifts) {
      return json({
        success: false,
        error: `You can only select up to ${maxGifts} products`,
      }, { headers: corsHeaders, status: 400 });
    }

    // Get Appstle settings
    const appSettings = await prisma.appSettings.findUnique({
      where: { shop: eligibility.shop },
    });

    if (!appSettings?.appstleApiKey) {
      console.log("Appstle API key not configured for shop:", eligibility.shop);
      return json({
        success: false,
        error: "Gift system is not configured. Please contact support.",
      }, { headers: corsHeaders, status: 500 });
    }

    // Create Appstle service
    const appstleService = createAppstleService(
      appSettings.appstleApiKey,
      eligibility.shop,
      appSettings.appstleApiUrl
    );

    // Save selections to database
    console.log("Saving selections to database...");
    const selections = await Promise.all(
      products.map((product) =>
        prisma.giftSelection.create({
          data: {
            giftEligibilityId: eligibility.id,
            variantId: product.variantId,
            productTitle: product.title,
            quantity: 1,
          },
        })
      )
    );

    // Add products to subscription via Appstle API
    console.log("Adding products to subscription via Appstle...");
    const addResults = await appstleService.addGiftProducts(
      eligibility.subscriptionContractId,
      products.map((p) => ({ variantId: p.variantId, quantity: 1 }))
    );

    console.log("Appstle add results:", addResults);

    // Update selections with Appstle line IDs
    for (let i = 0; i < addResults.results.length; i++) {
      const result = addResults.results[i];
      if (result.success && result.lineId) {
        await prisma.giftSelection.update({
          where: { id: selections[i].id },
          data: {
            addedToSubscription: true,
            appstleLineId: result.lineId,
          },
        });
      }
    }

    // Update eligibility status
    await prisma.giftEligibility.update({
      where: { id: eligibility.id },
      data: {
        status: addResults.success ? "applied" : "selected",
        selectedAt: new Date(),
        appliedAt: addResults.success ? new Date() : null,
      },
    });

    if (!addResults.success) {
      // Some products failed to add
      const failedCount = addResults.results.filter((r) => !r.success).length;
      const errors = addResults.results.filter((r) => !r.success).map((r) => r.error).join(", ");
      console.log("Some products failed to add:", errors);
      return json({
        success: true,
        partial: true,
        message: `${products.length - failedCount} of ${products.length} products were added. Some failed: ${errors}`,
      }, { headers: corsHeaders });
    }

    console.log("Gift selection successful!");
    return json({
      success: true,
      message: "Your free gifts have been added to your next order!",
    }, { headers: corsHeaders });

  } catch (error) {
    console.error("Error processing gift selection:", error);
    return json({
      success: false,
      error: `An error occurred: ${error instanceof Error ? error.message : "Unknown error"}`,
    }, { headers: corsHeaders, status: 500 });
  }
};

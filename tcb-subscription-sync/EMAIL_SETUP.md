# Email Setup for Gift Notifications

## Overview

When a subscriber reaches a milestone order (3, 5, 10, etc.), they become eligible for free gift products. This guide explains how to send them email notifications.

## Option 1: Manual Email (Recommended for Start)

For each eligible subscriber, you can:

1. Go to **Gift Management** in the app
2. Copy the gift link generated for the customer
3. Send a manual email through Shopify Admin → Customers → Select customer → Send email

### Email Template

```
Subject: 🎁 You've earned free products on your next order!

Hi [Customer Name],

Congratulations! As a thank you for being a loyal subscriber, you've earned FREE products on your next subscription order!

You can choose up to 3 free products to be added to your next delivery.

👉 Click here to select your free gifts: [GIFT_LINK]

This offer expires in 14 days, so don't wait!

Thank you for being part of the [Your Brand] family.

Best regards,
The [Your Brand] Team
```

## Option 2: Klaviyo Integration (Advanced)

### Setup Steps:

1. **Create a Klaviyo Flow**
   - Trigger: Custom Event "Gift Eligible"
   - Action: Send Email

2. **Add Webhook in App**
   Create a webhook endpoint that sends data to Klaviyo when gift eligibility is created.

3. **Klaviyo API Call Example:**
   ```javascript
   // POST to https://a.klaviyo.com/api/events/
   {
     "data": {
       "type": "event",
       "attributes": {
         "profile": {
           "email": "customer@example.com",
           "first_name": "John",
           "last_name": "Doe"
         },
         "metric": {
           "name": "Gift Eligible"
         },
         "properties": {
           "gift_link": "https://your-store.myshopify.com/pages/gift-selection?token=xxx",
           "order_number": 3,
           "expires_at": "2024-02-15"
         }
       }
     }
   }
   ```

## Option 3: Shopify Flow + Email

1. **Install Shopify Flow** (Plus merchants)
2. Create a flow triggered by webhook
3. Send notification email through Flow's email action

## Gift Selection Page Setup

1. In Shopify Admin, go to **Online Store → Themes → Edit code**
2. Under **Templates**, click **Add a new template**
3. Select **page** and name it `gift-selection`
4. Copy the contents of `gift-selection-page.liquid` from this folder
5. Save the template
6. Create a new **Page** in Shopify Admin with this template
7. The page URL will be: `https://your-store.myshopify.com/pages/gift-selection`

## How the Flow Works

```
┌─────────────────┐
│ Order Completed │
│  (via webhook)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Check if order  │──No──► End
│ # = 3, 5, 10... │
└────────┬────────┘
         │ Yes
         ▼
┌─────────────────┐
│ Create Gift     │
│ Eligibility     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Wait 7 days     │
│ (configurable)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Send Email with │
│ Gift Link       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Customer clicks │
│ link & selects  │
│ 3 products      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Products added  │
│ to subscription │
│ as $0 one-time  │
└─────────────────┘
```

## Testing

1. Create a test gift eligibility manually in the app
2. Copy the generated gift link
3. Open the link in incognito/private browser
4. Select products and submit
5. Check Appstle to verify products were added to subscription

## Troubleshooting

- **Gift link not working**: Check if the token has expired
- **Products not adding**: Verify Appstle API key is correct in Settings
- **Page not loading products**: Ensure the gift selection page template is set up correctly

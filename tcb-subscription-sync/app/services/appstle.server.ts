/**
 * Appstle Subscription API Service
 *
 * This service handles all communication with the Appstle Subscription API.
 * API Documentation: https://subscription-admin.appstle.com/swagger-ui/appstle-subscriptions-api.html
 */

export interface AppstleConfig {
  apiKey: string;
  apiUrl?: string;
}

export interface SubscriptionContract {
  // Appstle internal ID (e.g., 9048848)
  id: number | string;
  // Appstle subscription contract ID (e.g., 120951144534)
  subscriptionContractId?: number | string;
  contractId?: string;
  graphSubscriptionContractId?: string;
  status: string;
  customerId: number | string;
  customerEmail?: string;
  customerFirstName?: string;
  customerLastName?: string;
  customerName?: string;
  billingPolicy?: {
    interval: string;
    intervalCount: number;
  };
  deliveryPolicy?: {
    interval: string;
    intervalCount: number;
  };
  nextBillingDate?: string;
  createdAt?: string;
  // Order tracking fields
  totalSuccessfulOrders?: number; // THIS is the actual order count!
  currentBillingCycle?: number;
  billingCycleCount?: number;
  orderCount?: number;
  totalOrdersDelivered?: number;
  orderName?: string; // First/initial order ID like "#1005"
  orderId?: number | string;
  // Last successful order info (JSON string)
  lastSuccessfulOrder?: string;
  lifetimeValue?: number;
  // Additional fields from API
  contractDetailsJSON?: string;
}

export interface SubscriptionContractsResponse {
  subscriptionContracts: SubscriptionContract[];
  totalCount: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface SyncFilter {
  minOrdersDelivered?: number;
  status?: string[];
}

const DEFAULT_API_URL = "https://subscription-admin.appstle.com";

export class AppstleService {
  private apiKey: string;
  private apiUrl: string;
  private shopDomain: string;

  constructor(config: AppstleConfig, shopDomain: string) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl || DEFAULT_API_URL;
    this.shopDomain = shopDomain;
  }

  private async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;

    // Authentication: Appstle API docs specify X-API-Key header
    // Also include shop domain for context
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-API-Key": this.apiKey,
      "X-Shopify-Shop-Domain": this.shopDomain,
      ...(options.headers as Record<string, string> || {}),
    };

    // Mask API key for logging (show first 8 and last 4 chars)
    const maskedKey = this.apiKey.length > 12
      ? `${this.apiKey.substring(0, 8)}...${this.apiKey.substring(this.apiKey.length - 4)}`
      : '***';

    console.log(`Appstle API Request: ${options.method || 'GET'} ${url}`);
    console.log(`Shop: ${this.shopDomain}, API Key: ${maskedKey}`);

    const response = await fetch(url, {
      ...options,
      headers,
    });

    console.log(`Appstle API Response: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Appstle API Error: ${response.status}`, errorText);
      throw new Error(
        `Appstle API Error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    // Handle empty responses
    const text = await response.text();
    console.log(`Response body length: ${text.length} chars`);

    if (!text) {
      console.log('Empty response body received');
      return {} as T;
    }

    try {
      return JSON.parse(text);
    } catch (parseError) {
      console.error('Failed to parse response as JSON:', text.substring(0, 200));
      throw new Error(`Invalid JSON response: ${text.substring(0, 100)}`);
    }
  }

  /**
   * Fetch subscription contracts from Appstle
   * Uses GET /api/external/v2/subscription-contract-details endpoint
   */
  async getSubscriptionContracts(
    page: number = 0,
    pageSize: number = 50,
    status?: string
  ): Promise<SubscriptionContractsResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      size: pageSize.toString(),
    });

    if (status) {
      params.append("status", status);
    }

    // Correct Appstle API endpoint from Swagger docs
    const endpoint = `/api/external/v2/subscription-contract-details?${params.toString()}`;

    try {
      const response = await this.makeRequest<{
        content?: SubscriptionContract[];
        subscriptionContractDetails?: SubscriptionContract[];
        subscriptionContracts?: SubscriptionContract[];
        totalElements?: number;
        totalCount?: number;
        totalPages?: number;
        number?: number;
        page?: number;
        size?: number;
        pageSize?: number;
        last?: boolean;
        empty?: boolean;
      }>(endpoint);

      // Handle different possible response structures
      const contracts = response.content ||
                       response.subscriptionContractDetails ||
                       response.subscriptionContracts ||
                       (Array.isArray(response) ? response : []);
      const total = response.totalElements || response.totalCount || contracts.length;
      const currentPage = response.number || response.page || page;
      const size = response.size || response.pageSize || pageSize;
      const hasMore = response.last === false ||
                     (response.empty === false && contracts.length === pageSize) ||
                     contracts.length === pageSize;

      return {
        subscriptionContracts: contracts,
        totalCount: total,
        page: currentPage,
        pageSize: size,
        hasMore,
      };
    } catch (error) {
      console.error("Error fetching subscription contracts:", error);
      throw error;
    }
  }

  /**
   * Fetch all subscription contracts with pagination handling
   * Automatically fetches all pages
   */
  async getAllSubscriptionContracts(
    status?: string
  ): Promise<SubscriptionContract[]> {
    const allContracts: SubscriptionContract[] = [];
    let page = 0;
    let hasMore = true;
    const pageSize = 100;

    while (hasMore) {
      const response = await this.getSubscriptionContracts(page, pageSize, status);
      allContracts.push(...response.subscriptionContracts);
      hasMore = response.hasMore;
      page++;

      // Safety limit to prevent infinite loops
      if (page > 1000) {
        console.warn("Reached maximum page limit (1000), stopping pagination");
        break;
      }
    }

    return allContracts;
  }

  /**
   * Filter subscription contracts by minimum orders delivered
   * Uses totalSuccessfulOrders as the primary order count
   */
  filterByMinOrders(
    contracts: SubscriptionContract[],
    minOrders: number
  ): SubscriptionContract[] {
    return contracts.filter((contract) => {
      // totalSuccessfulOrders is the actual number of successful orders
      const ordersDelivered = contract.totalSuccessfulOrders || 0;
      return ordersDelivered >= minOrders;
    });
  }

  /**
   * Sync subscribers with filter
   * Main method to fetch and filter subscribers
   */
  async syncSubscribers(filter: SyncFilter = {}): Promise<{
    totalFetched: number;
    filteredSubscribers: SubscriptionContract[];
    filterApplied: SyncFilter;
  }> {
    // Fetch all contracts (optionally filter by status at API level)
    const statusFilter = filter.status?.length === 1 ? filter.status[0] : undefined;
    const allContracts = await this.getAllSubscriptionContracts(statusFilter);

    let filteredContracts = allContracts;

    // Apply status filter if multiple statuses
    if (filter.status && filter.status.length > 1) {
      filteredContracts = filteredContracts.filter((c) =>
        filter.status!.includes(c.status)
      );
    }

    // Apply minimum orders filter
    if (filter.minOrdersDelivered && filter.minOrdersDelivered > 0) {
      filteredContracts = this.filterByMinOrders(
        filteredContracts,
        filter.minOrdersDelivered
      );
    }

    return {
      totalFetched: allContracts.length,
      filteredSubscribers: filteredContracts,
      filterApplied: filter,
    };
  }

  /**
   * Get subscription contract by ID
   */
  async getSubscriptionContract(contractId: string): Promise<SubscriptionContract | null> {
    try {
      const endpoint = `/api/external/v2/subscription-contracts/${contractId}`;
      return await this.makeRequest<SubscriptionContract>(endpoint);
    } catch (error) {
      console.error(`Error fetching contract ${contractId}:`, error);
      return null;
    }
  }

  /**
   * Get order history for a subscription contract
   * Returns the list of orders and count
   */
  async getSubscriptionOrders(subscriptionContractId: string): Promise<{
    orders: Array<{
      orderId: string;
      orderName: string;
      createdAt: string;
      status: string;
    }>;
    totalCount: number;
    lastOrder?: {
      orderId: string;
      orderName: string;
      createdAt: string;
    };
  }> {
    // Try multiple endpoint formats
    const endpoints = [
      `/api/external/v2/subscription-contract-orders?subscriptionContractId=${subscriptionContractId}`,
      `/api/external/v2/subscription-contracts/${subscriptionContractId}/orders`,
      `/api/external/v2/subscription-contract/${subscriptionContractId}/orders`,
    ];

    for (const endpoint of endpoints) {
      try {
        console.log(`Trying endpoint: ${endpoint}`);
        const response = await this.makeRequest<{
          content?: Array<{
            orderId?: string | number;
            orderName?: string;
            createdAt?: string;
            status?: string;
          }>;
          orders?: Array<{
            orderId?: string | number;
            orderName?: string;
            createdAt?: string;
            status?: string;
          }>;
          totalElements?: number;
          totalCount?: number;
        }>(endpoint);

        console.log(`Order response from ${endpoint}:`, JSON.stringify(response).substring(0, 500));

        const orders = response.content || response.orders || [];
        if (Array.isArray(response) && response.length > 0) {
          // Response is array directly
          const directOrders = response as Array<{
            orderId?: string | number;
            orderName?: string;
            createdAt?: string;
            status?: string;
          }>;
          const totalCount = directOrders.length;
          const formattedOrders = directOrders.map(o => ({
            orderId: String(o.orderId || ''),
            orderName: o.orderName || '',
            createdAt: o.createdAt || '',
            status: o.status || 'unknown',
          }));
          const sortedOrders = [...formattedOrders].sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
          return {
            orders: formattedOrders,
            totalCount,
            lastOrder: sortedOrders[0] || undefined,
          };
        }

        const totalCount = response.totalElements || response.totalCount || orders.length;

        if (orders.length > 0 || totalCount > 0) {
          const formattedOrders = orders.map(o => ({
            orderId: String(o.orderId || ''),
            orderName: o.orderName || '',
            createdAt: o.createdAt || '',
            status: o.status || 'unknown',
          }));

          const sortedOrders = [...formattedOrders].sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );

          return {
            orders: formattedOrders,
            totalCount,
            lastOrder: sortedOrders[0] || undefined,
          };
        }
      } catch (error) {
        console.log(`Endpoint ${endpoint} failed:`, error);
        continue;
      }
    }

    console.error(`Could not fetch orders for contract ${subscriptionContractId} from any endpoint`);
    return { orders: [], totalCount: 0 };
  }

  /**
   * Update subscription status
   */
  async updateSubscriptionStatus(
    contractId: string,
    status: "ACTIVE" | "PAUSED" | "CANCELLED"
  ): Promise<void> {
    const endpoint = `/api/external/v2/subscription-contracts-update-status?contractId=${contractId}&status=${status}`;
    await this.makeRequest(endpoint, { method: "PUT" });
  }

  /**
   * Test API connection
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      // Try to fetch subscription groups as a connection test
      await this.makeRequest("/api/external/v2/subscription-groups");
      return { success: true, message: "Successfully connected to Appstle API" };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Failed to connect to Appstle API",
      };
    }
  }

  /**
   * Convert a variant ID to Shopify GID format if needed
   */
  private toVariantGid(variantId: string): string {
    // If already in GID format, return as-is
    if (variantId.startsWith('gid://')) {
      return variantId;
    }
    // Convert numeric ID to GID format
    return `gid://shopify/ProductVariant/${variantId}`;
  }

  /**
   * Extract numeric ID from variant (handles both GID and numeric formats)
   */
  private toNumericVariantId(variantId: string): string {
    if (variantId.startsWith('gid://')) {
      // Extract numeric part from GID
      const parts = variantId.split('/');
      return parts[parts.length - 1];
    }
    return variantId;
  }

  /**
   * Contract details type
   */
  private ContractType: {
    id?: number | string;
    subscriptionContractId?: number | string;
    billingAttemptId?: number | string;
    nextBillingAttemptId?: number | string;
    upcomingBillingAttemptId?: number | string;
    status?: string;
    nextBillingDate?: string;
  } | undefined;

  /**
   * Get contract details including billing attempt info from the working endpoint
   * Paginates through all contracts to find the one we need
   */
  private async getContractDetailsWithBilling(contractId: string): Promise<{
    billingAttemptId: string | null;
    subscriptionContractId: string | null;
    appstleInternalId: string | null;
    status: string | null;
    nextBillingDate: string | null;
  }> {
    type ContractData = {
      id?: number | string;
      subscriptionContractId?: number | string;
      billingAttemptId?: number | string;
      nextBillingAttemptId?: number | string;
      upcomingBillingAttemptId?: number | string;
      status?: string;
      nextBillingDate?: string;
    };

    // Fetch all contracts with pagination
    const allContracts: ContractData[] = [];
    let page = 0;
    const pageSize = 100;
    let hasMore = true;

    console.log(`Getting contract details for ID ${contractId}...`);

    while (hasMore && page < 10) {  // Max 10 pages to prevent infinite loops
      try {
        const endpoint = `/api/external/v2/subscription-contract-details?page=${page}&size=${pageSize}`;
        console.log(`Fetching page ${page}...`);

        const response = await this.makeRequest<
          ContractData[] | { content?: ContractData[]; last?: boolean; totalPages?: number }
        >(endpoint, { method: 'GET' });

        // Handle both array and object responses
        let contracts: ContractData[];
        if (Array.isArray(response)) {
          contracts = response;
          hasMore = contracts.length === pageSize;
        } else {
          contracts = response.content || [];
          hasMore = response.last === false || contracts.length === pageSize;
        }

        allContracts.push(...contracts);
        console.log(`Page ${page}: Found ${contracts.length} contracts (total: ${allContracts.length})`);

        // Check if we found our contract in this page
        const foundContract = contracts.find(c =>
          String(c.id) === contractId ||
          String(c.subscriptionContractId) === contractId
        );

        if (foundContract) {
          console.log(`Found contract on page ${page}:`, JSON.stringify(foundContract).substring(0, 500));
          return {
            billingAttemptId: foundContract.billingAttemptId
              ? String(foundContract.billingAttemptId)
              : foundContract.nextBillingAttemptId
                ? String(foundContract.nextBillingAttemptId)
                : foundContract.upcomingBillingAttemptId
                  ? String(foundContract.upcomingBillingAttemptId)
                  : null,
            subscriptionContractId: foundContract.subscriptionContractId
              ? String(foundContract.subscriptionContractId)
              : null,
            appstleInternalId: foundContract.id ? String(foundContract.id) : null,
            status: foundContract.status || null,
            nextBillingDate: foundContract.nextBillingDate || null,
          };
        }

        page++;
      } catch (error) {
        console.log(`Error fetching page ${page}:`, error);
        hasMore = false;
      }
    }

    // Log all available contracts for debugging
    console.log(`Contract ${contractId} not found. Available contracts (${allContracts.length} total):`);
    allContracts.forEach(c => {
      console.log(`  - id: ${c.id}, subscriptionContractId: ${c.subscriptionContractId}, status: ${c.status}`);
    });

    return { billingAttemptId: null, subscriptionContractId: null, appstleInternalId: null, status: null, nextBillingDate: null };
  }

  /**
   * Get the upcoming billing attempt ID for a contract
   * Tries multiple methods to find the billing attempt
   */
  private async getUpcomingBillingAttemptId(contractId: string): Promise<string | null> {
    // Method 1: Get from contract details (working endpoint)
    const contractInfo = await this.getContractDetailsWithBilling(contractId);
    console.log(`Contract info:`, contractInfo);

    if (contractInfo.billingAttemptId) {
      return contractInfo.billingAttemptId;
    }

    // Check if contract has issues
    if (contractInfo.status && contractInfo.status !== 'ACTIVE') {
      console.log(`Warning: Contract status is ${contractInfo.status}, not ACTIVE`);
    }

    if (!contractInfo.nextBillingDate) {
      console.log(`Warning: Contract has no next billing date scheduled`);
    }

    // Method 2: Try to get upcoming one-offs (might have billing attempt info)
    try {
      console.log(`Getting upcoming one-offs for contract ${contractId}...`);
      const upcomingEndpoint = `/api/external/v2/upcoming-subscription-contract-one-offs-by-contractId?contractId=${contractId}`;
      const response = await this.makeRequest<Array<{
        billingAttemptId?: number | string;
        id?: number | string;
      }>>(upcomingEndpoint, { method: 'GET' });

      console.log(`Upcoming one-offs response:`, JSON.stringify(response).substring(0, 500));

      if (Array.isArray(response) && response.length > 0) {
        const billingId = response[0].billingAttemptId || response[0].id;
        if (billingId) return String(billingId);
      }
    } catch (error) {
      console.log(`Could not get upcoming one-offs:`, error);
    }

    return null;
  }

  /**
   * Add a one-time product to subscription as a free gift
   * Uses the one-offs endpoint with the correct parameters
   */
  async addGiftProduct(
    contractId: string | number,
    variantId: string,
    quantity: number = 1,
    variantHandle?: string
  ): Promise<{
    success: boolean;
    lineId?: string;
    error?: string;
  }> {
    const contractIdStr = String(contractId);
    const numericVariantId = this.toNumericVariantId(variantId);
    const gidVariantId = this.toVariantGid(variantId);
    // Ensure handle matches pattern ^[a-z0-9]+(?:-[a-z0-9]+)*$
    const rawHandle = variantHandle || 'default-title';
    const handle = rawHandle.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'default';

    console.log(`=== Adding gift product ===`);
    console.log(`Contract ID: ${contractIdStr}`);
    console.log(`Variant ID: ${variantId} (numeric: ${numericVariantId}, GID: ${gidVariantId})`);
    console.log(`Variant Handle: ${handle} (raw: ${rawHandle})`);

    // Collect all errors for reporting
    const errors: string[] = [];

    // First get contract details to find the billing attempt ID and validate the contract
    let contractInfo = await this.getContractDetailsWithBilling(contractIdStr);
    console.log(`Contract info for ID ${contractIdStr}:`, contractInfo);

    // If contract not found by the Appstle internal ID, it might be stored with the Shopify contract ID
    // The getContractDetailsWithBilling already searches by both IDs, so if not found, contract doesn't exist
    if (!contractInfo.appstleInternalId) {
      console.log(`Contract ${contractIdStr} not found in Appstle.`);
      console.log(`This could mean:`);
      console.log(`  1. The subscription ID is incorrect`);
      console.log(`  2. The subscription was deleted in Appstle`);
      console.log(`  3. The API key doesn't have access to this subscription`);

      return {
        success: false,
        error: `Subscription not found in Appstle. Please verify the subscription exists and re-sync your subscribers.`,
      };
    }

    // Check if subscription is active and has a scheduled order
    if (contractInfo.status && contractInfo.status.toLowerCase() !== 'active') {
      return {
        success: false,
        error: `Subscription is ${contractInfo.status}. Only ACTIVE subscriptions can receive gift products.`,
      };
    }

    // The Appstle API requires at least one QUEUED billing attempt
    // If there's no next billing date, the subscription might not have upcoming orders
    if (!contractInfo.nextBillingDate && !contractInfo.billingAttemptId) {
      console.log(`Warning: No next billing date or billing attempt found`);
      errors.push('Subscription has no scheduled next order');
    }

    const billingAttemptId = contractInfo.billingAttemptId;
    const actualContractId = contractInfo.appstleInternalId || contractIdStr;
    console.log(`Using contract ID: ${actualContractId}, billing attempt ID: ${billingAttemptId}`);

    // The correct endpoint from docs:
    // PUT /api/external/v2/subscription-contract-one-offs-by-contractId-and-billing-attempt-id
    const oneOffEndpoint = '/api/external/v2/subscription-contract-one-offs-by-contractId-and-billing-attempt-id';

    // Prepare billing attempt IDs to try
    // According to docs: "If invalid or not QUEUED, system uses next upcoming order"
    const billingAttemptIds = billingAttemptId
      ? [billingAttemptId]
      : ['1'];  // Try a placeholder - API should auto-fallback

    // Try with the actual Appstle internal ID found from the API
    const contractIdsToTry = [actualContractId];

    // Also try the Shopify subscription contract ID if different
    if (contractInfo.subscriptionContractId && contractInfo.subscriptionContractId !== actualContractId) {
      contractIdsToTry.push(contractInfo.subscriptionContractId);
    }

    // Variant handles to try - limited to reduce API calls
    const variantHandlesToTry = [handle, 'default-title'];

    // Try combinations
    for (const cid of contractIdsToTry) {
      for (const attemptId of billingAttemptIds) {
        for (const handleAttempt of variantHandlesToTry) {
          const params = new URLSearchParams({
            contractId: cid,
            billingAttemptId: attemptId,
            variantId: numericVariantId,
            variantHandle: handleAttempt,
            quantity: String(quantity),
          });

          const fullEndpoint = `${oneOffEndpoint}?${params.toString()}`;
          console.log(`Trying: ${this.apiUrl}${fullEndpoint}`);

          try {
            const response = await this.makeRequest<Record<string, unknown> | Array<Record<string, unknown>>>(
              fullEndpoint,
              { method: 'PUT' }
            );
            console.log(`Response:`, JSON.stringify(response));

            // Handle array response (API returns array on success)
            if (Array.isArray(response) && response.length > 0) {
              console.log(`SUCCESS with contractId=${cid}, billingAttemptId=${attemptId}, variantHandle=${handleAttempt}`);
              return { success: true, lineId: String(response[0].id || '') };
            }

            // Handle empty array (might be success with idempotent call)
            if (Array.isArray(response) && response.length === 0) {
              console.log(`Empty array response - checking if this is success...`);
              // Empty array might mean the product was already added (idempotent)
              // Let's consider this a success
              return { success: true, lineId: '' };
            }

            // Handle object response
            if (response && typeof response === 'object' && !Array.isArray(response)) {
              if (Object.keys(response).length > 0 && !response.error && !response.message?.toString().includes('error')) {
                console.log(`SUCCESS with contractId=${cid}, billingAttemptId=${attemptId}, variantHandle=${handleAttempt}`);
                return { success: true, lineId: String(response.id || '') };
              }
            }
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Request failed';
            // Extract just the important part of the error
            const shortErr = errMsg.includes('"detail"')
              ? errMsg.match(/"detail"\s*:\s*"([^"]+)"/)?.[1] || errMsg.substring(0, 100)
              : errMsg.substring(0, 100);
            errors.push(`contractId=${cid}, billing=${attemptId}: ${shortErr}`);
            console.log(`Failed: ${errMsg}`);
          }
        }
      }
    }

    // If all attempts failed, return a user-friendly error
    console.error(`All attempts failed. Errors:\n${errors.join('\n')}`);

    // Check for common issues
    if (errors.some(e => e.includes('No value present'))) {
      return {
        success: false,
        error: `Could not add product to subscription. The subscription may not have a scheduled next order, or the billing attempt is not in QUEUED status. Please check the subscription in Appstle admin.`,
      };
    }

    return {
      success: false,
      error: `Failed to add product: ${errors[0] || 'Unknown error'}`,
    };
  }

  /**
   * Add multiple gift products to a subscription
   */
  async addGiftProducts(
    contractId: string | number,
    products: Array<{ variantId: string; quantity?: number; variantHandle?: string }>
  ): Promise<{
    success: boolean;
    results: Array<{ variantId: string; success: boolean; lineId?: string; error?: string }>;
  }> {
    const results: Array<{ variantId: string; success: boolean; lineId?: string; error?: string }> = [];

    for (const product of products) {
      const result = await this.addGiftProduct(
        contractId,
        product.variantId,
        product.quantity || 1,
        product.variantHandle
      );
      results.push({
        variantId: product.variantId,
        ...result,
      });

      // Small delay between requests to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const allSuccess = results.every((r) => r.success);
    return { success: allSuccess, results };
  }
}

/**
 * Create Appstle service instance from database settings
 */
export function createAppstleService(
  apiKey: string,
  shopDomain: string,
  apiUrl?: string
): AppstleService {
  return new AppstleService(
    {
      apiKey,
      apiUrl,
    },
    shopDomain
  );
}

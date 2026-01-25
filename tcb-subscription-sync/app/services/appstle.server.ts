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

    // Try multiple authentication methods
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey,
      "Authorization": `Bearer ${this.apiKey}`,
      "api_key": this.apiKey,
      "X-Shopify-Shop-Domain": this.shopDomain,
      "shop": this.shopDomain,
      ...(options.headers as Record<string, string> || {}),
    };

    console.log(`Appstle API Request: ${url}`);

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Appstle API Error: ${response.status}`, errorText);
      throw new Error(
        `Appstle API Error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text);
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
   * Add a one-time product to subscription as a free gift
   * Uses the addLineItemV2_1 endpoint with price = 0
   * Note: This endpoint uses PUT method with query parameters
   */
  async addGiftProduct(
    contractId: string | number,
    variantId: string,
    quantity: number = 1
  ): Promise<{
    success: boolean;
    lineId?: string;
    error?: string;
  }> {
    try {
      const params = new URLSearchParams({
        contractId: String(contractId),
        variantId: variantId,
        quantity: String(quantity),
        price: "0", // Free gift
        isOneTimeProduct: "true", // One-time only
      });

      // Try PUT method first (as per Appstle API docs)
      const endpoint = `/api/external/v2/add-line-item-with-custom-price?${params.toString()}`;

      console.log(`Adding gift product to contract ${contractId}: variant ${variantId}`);
      console.log(`Endpoint: ${endpoint}`);

      const response = await this.makeRequest<{
        id?: string;
        lines?: {
          edges?: Array<{
            node?: {
              id?: string;
              variantId?: string;
            };
          }>;
          nodes?: Array<{
            id?: string;
            variantId?: string;
          }>;
        };
      }>(endpoint, { method: "PUT" });

      console.log(`Appstle response:`, JSON.stringify(response).substring(0, 500));

      // Find the newly added line
      const edges = response.lines?.edges || [];
      const nodes = response.lines?.nodes || [];

      let lineId = response.id;

      const addedEdge = edges.find(
        (edge) => edge.node?.variantId?.includes(variantId)
      );
      if (addedEdge?.node?.id) {
        lineId = addedEdge.node.id;
      }

      const addedNode = nodes.find(
        (node) => node.variantId?.includes(variantId)
      );
      if (addedNode?.id) {
        lineId = addedNode.id;
      }

      return {
        success: true,
        lineId: lineId,
      };
    } catch (error) {
      console.error(`Error adding gift product to contract ${contractId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to add gift product",
      };
    }
  }

  /**
   * Add multiple gift products to a subscription
   */
  async addGiftProducts(
    contractId: string | number,
    products: Array<{ variantId: string; quantity?: number }>
  ): Promise<{
    success: boolean;
    results: Array<{ variantId: string; success: boolean; lineId?: string; error?: string }>;
  }> {
    const results: Array<{ variantId: string; success: boolean; lineId?: string; error?: string }> = [];

    for (const product of products) {
      const result = await this.addGiftProduct(
        contractId,
        product.variantId,
        product.quantity || 1
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

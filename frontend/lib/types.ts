export type ItemType = "lost" | "found";
export type ItemStatus = "open" | "claimed" | "returned" | "closed";
export type Category =
  | "phone"
  | "electronics"
  | "wallet"
  | "bag"
  | "keys"
  | "documents"
  | "jewelry"
  | "clothing"
  | "pet"
  | "other";

export const CATEGORIES: Category[] = [
  "phone",
  "electronics",
  "wallet",
  "bag",
  "keys",
  "documents",
  "jewelry",
  "clothing",
  "pet",
  "other",
];

export type ItemImage = { id: number; url: string; thumbUrl: string; width: number; height: number };

export type Item = {
  id: number;
  type: ItemType;
  title: string;
  category: Category;
  description: string;
  location: string;
  approxLatitude: number | null;
  approxLongitude: number | null;
  locationSource: "provider" | "device" | "manual" | "legacy";
  hasCoordinates: boolean;
  locationCountry: string | null;
  // Approximate, banded distance (1 means "under 1 km"); absent without coordinates.
  distanceKm?: number;
  date: string;
  status: ItemStatus;
  ownershipQuestion: string | null;
  createdAt: string;
  updatedAt: string;
  images: ItemImage[];
  reporter: { displayName: string };
  reward: { kind: "finder_reward" | "category_reward"; amountPaise: number; currency: "INR" } | null;
  categoryConfirmed: boolean;
  closureReason: ClosureReason | null;
  // Owner/moderator view only
  latitude?: number | null;
  longitude?: number | null;
  locationPlaceId?: string | null;
  locationProvider?: string | null;
  locationAccuracyM?: number | null;
  moderationState?: "visible" | "removed" | "pending";
  pendingClaims?: number;
};

export type Viewer = {
  isOwner: boolean;
  canModerate: boolean;
  claim: { id: number; status: ClaimStatus } | null;
  conversationId: number | null;
  hasReported?: boolean;
  pendingClaims?: number;
};

export type ClaimStatus = "pending" | "accepted" | "declined" | "withdrawn" | "revoked" | "superseded";

export type Agreement = {
  category: Category;
  rewardPaise: number;
  feePaise: number;
  currency: "INR";
  pricingVersion: string;
  termsVersion?: string;
  acceptedAt?: string;
  current?: boolean;
};

export type PaymentStatus = "none" | "created" | "pending" | "paid" | "failed" | "cancelled" | "refund_pending" | "refunded";
export type RewardStatus = "awaiting" | "confirmed" | "issue";
export type ReturnState = "awaiting_connection" | "arranging" | "awaiting_owner" | "returned";
export type ClosureReason = "returned_matched" | "self_recovered" | "returned_external" | "closed_by_reporter" | "legacy_returned";

export type Claim = {
  id: number;
  itemId: number;
  status: ClaimStatus;
  claimant: { id: number; displayName: string };
  viewerRole: "owner" | "finder" | null;
  claimantRole: "owner" | "finder";
  answer?: string;
  agreement: Agreement | null;
  payment: { status: PaymentStatus };
  unlocked: boolean;
  unlockSource: "grandfathered" | "payment" | null;
  returnConfirmedAt: string | null;
  handoverAt: string | null;
  returnState: ReturnState | null;
  returnIssueOpen: boolean;
  linkedItemId: number | null;
  closeReason: string | null;
  item: { status: ItemStatus; closureReason: ClosureReason | null };
  reward: { status: RewardStatus; at: string | null; note: string | null };
  createdAt: string;
  decidedAt: string | null;
  conversationId: number | null;
};

export type User = {
  id: number;
  name: string | null;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  profileImage: string | null;
  phone: string | null;
  locale: string | null;
  role: "user" | "moderator" | "admin";
};

export type SearchResult = { items: Item[]; page: number; pageSize: number; total: number; totalPages: number };

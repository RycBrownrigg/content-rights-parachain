use codec::{Decode, DecodeWithMemTracking, Encode, MaxEncodedLen};
use frame::prelude::*;
use scale_info::TypeInfo;

/// The kind of rights token minted as a child NFT under a Content NFT.
#[derive(Encode, Decode, DecodeWithMemTracking, MaxEncodedLen, TypeInfo, Clone, PartialEq, Eq, Debug)]
pub enum RightsType {
	Subscription,
	PayPerView,
	Ownership,
}

/// Stored per content item. Registered by the creator.
#[derive(Encode, Decode, MaxEncodedLen, TypeInfo, Clone, PartialEq, Eq, Debug)]
#[scale_info(skip_type_params(T))]
pub struct ContentMetadata<T: frame_system::Config> {
	pub creator: T::AccountId,
	pub metadata_hash: [u8; 32],
	pub collection_id: u32,
	pub content_item_id: u32,
	pub title: BoundedVec<u8, ConstU32<128>>,
	pub subscription_price: u128,
	pub ppv_price: u128,
	pub ownership_price: u128,
	pub period_length: u32,
}

/// Tracks subscription state for a specific user on specific content.
#[derive(Encode, Decode, MaxEncodedLen, TypeInfo, Clone, PartialEq, Eq, Debug)]
pub struct SubscriptionInfo {
	pub expiry_block: u32,
	pub auto_renew: bool,
	pub child_item_id: u32,
}

/// Tracks PPV state for a specific user on specific content.
#[derive(Encode, Decode, MaxEncodedLen, TypeInfo, Clone, PartialEq, Eq, Debug)]
pub struct ViewPackInfo {
	pub views_remaining: u32,
	pub child_item_id: u32,
}

/// Tracks permanent ownership for a specific user on specific content.
#[derive(Encode, Decode, MaxEncodedLen, TypeInfo, Clone, PartialEq, Eq, Debug)]
pub struct OwnershipInfo {
	pub child_item_id: u32,
}

/// A single royalty split entry: recipient gets `basis_points` out of 10,000.
/// Uses a fixed AccountId32 to avoid generic type complexity in storage.
/// Rich rights metadata that can be carried in XCM messages.
/// Enables receiving chains to understand the complete rights policy
/// without querying the origin chain.
#[derive(Encode, Decode, DecodeWithMemTracking, MaxEncodedLen, TypeInfo, Clone, PartialEq, Eq, Debug)]
pub struct RightsMetadata {
	pub content_id: u32,
	pub rights_type: RightsType,
	pub metadata_hash: [u8; 32],
	pub title: BoundedVec<u8, ConstU32<128>>,
	pub subscription_price: u128,
	pub ppv_price: u128,
	pub ownership_price: u128,
	pub period_length: u32,
	pub royalty_total_basis_points: u16,
	pub num_collaborators: u8,
}

#[derive(Encode, Decode, DecodeWithMemTracking, MaxEncodedLen, TypeInfo, Clone, PartialEq, Eq, Debug)]
pub struct RoyaltySplit {
	pub recipient: [u8; 32], // AccountId32 as raw bytes
	pub basis_points: u16,   // out of 10,000 (e.g., 2500 = 25%)
}

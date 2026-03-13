#![cfg_attr(not(feature = "std"), no_std, no_main)]

/// RightsManager — ink! 6 smart contract for content rights management.
///
/// This contract provides the user-facing API for the Cross-Chain Content Rights
/// Management Service. It currently uses contract-local storage to manage content
/// registration, subscriptions, pay-per-view, and permanent ownership.
///
/// In Step 4 (chain extensions), this contract will be connected to the
/// pallet-content-rights runtime pallet, delegating state to the native chain layer.
#[ink::contract]
mod rights_manager {
    use ink::storage::Mapping;
    use ink::{H160, U256};
    use scale::{Decode, Encode};

    // In ink! 6 on pallet-revive:
    //   - env().caller() returns H160 (20-byte Ethereum address)
    //   - env().transferred_value() returns U256
    //   - env().transfer(dest: H160, value: U256)
    // We use H160 and U256 directly, NOT the AccountId/Balance type aliases
    // from DefaultEnvironment (which are 32-byte AccountId and u128).

    // ==================== Types ====================

    /// Metadata for a registered content item.
    #[derive(Debug, Clone, Encode, Decode)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo, ink::storage::traits::StorageLayout))]
    pub struct ContentInfo {
        pub creator: H160,
        pub metadata_hash: [u8; 32],
        pub subscription_price: U256,
        pub ppv_price: U256,
        pub ownership_price: U256,
        /// Subscription period length in blocks.
        pub period_length: u32,
    }

    /// Subscription state for a (content_id, subscriber) pair.
    #[derive(Debug, Clone, Encode, Decode)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo, ink::storage::traits::StorageLayout))]
    pub struct SubscriptionState {
        pub expiry_block: u32,
    }

    /// Pay-per-view state for a (content_id, viewer) pair.
    #[derive(Debug, Clone, Encode, Decode)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo, ink::storage::traits::StorageLayout))]
    pub struct ViewPackState {
        pub views_remaining: u32,
    }

    /// The type of access right found for a user.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub enum RightsType {
        Subscription,
        PayPerView,
        Ownership,
        None,
    }

    // ==================== Storage ====================

    #[ink(storage)]
    pub struct RightsManager {
        /// Content ID -> ContentInfo
        contents: Mapping<u32, ContentInfo>,
        /// Next content ID to assign
        next_content_id: u32,
        /// (content_id, subscriber) -> SubscriptionState
        subscriptions: Mapping<(u32, H160), SubscriptionState>,
        /// (content_id, viewer) -> ViewPackState
        view_packs: Mapping<(u32, H160), ViewPackState>,
        /// (content_id, owner) -> bool
        ownership: Mapping<(u32, H160), bool>,
    }

    // ==================== Events ====================

    #[ink(event)]
    pub struct ContentRegistered {
        #[ink(topic)]
        content_id: u32,
        creator: H160,
    }

    #[ink(event)]
    pub struct SubscriptionCreated {
        #[ink(topic)]
        content_id: u32,
        subscriber: H160,
        expiry_block: u32,
    }

    #[ink(event)]
    pub struct SubscriptionRenewed {
        #[ink(topic)]
        content_id: u32,
        subscriber: H160,
        new_expiry_block: u32,
    }

    #[ink(event)]
    pub struct ViewPackPurchased {
        #[ink(topic)]
        content_id: u32,
        buyer: H160,
        views: u32,
    }

    #[ink(event)]
    pub struct ViewConsumed {
        #[ink(topic)]
        content_id: u32,
        viewer: H160,
        views_remaining: u32,
    }

    #[ink(event)]
    pub struct OwnershipPurchased {
        #[ink(topic)]
        content_id: u32,
        buyer: H160,
    }

    // ==================== Errors ====================

    #[derive(Debug, PartialEq, Eq, Encode, Decode)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub enum Error {
        ContentNotFound,
        SubscriptionAlreadyExists,
        SubscriptionNotFound,
        SubscriptionNotExpired,
        ViewPackNotFound,
        NoViewsRemaining,
        AlreadyOwned,
        InsufficientPayment,
        TransferFailed,
    }

    pub type Result<T> = core::result::Result<T, Error>;

    // ==================== Contract ====================

    impl RightsManager {
        /// Create a new RightsManager contract.
        #[ink(constructor)]
        pub fn new() -> Self {
            Self {
                contents: Mapping::default(),
                next_content_id: 0,
                subscriptions: Mapping::default(),
                view_packs: Mapping::default(),
                ownership: Mapping::default(),
            }
        }

        // --------------- Content Registration ---------------

        /// Register new content with pricing parameters.
        /// Returns the assigned content ID.
        #[ink(message)]
        pub fn register_content(
            &mut self,
            metadata_hash: [u8; 32],
            subscription_price: U256,
            ppv_price: U256,
            ownership_price: U256,
            period_length: u32,
        ) -> Result<u32> {
            let caller = self.env().caller();
            let content_id = self.next_content_id;

            let info = ContentInfo {
                creator: caller,
                metadata_hash,
                subscription_price,
                ppv_price,
                ownership_price,
                period_length,
            };

            self.contents.insert(content_id, &info);
            self.next_content_id = content_id.wrapping_add(1);

            self.env().emit_event(ContentRegistered {
                content_id,
                creator: caller,
            });

            Ok(content_id)
        }

        // --------------- Subscription Management ---------------

        /// Subscribe to content. Must send at least the subscription price as value.
        #[ink(message, payable)]
        pub fn subscribe(&mut self, content_id: u32) -> Result<()> {
            let caller = self.env().caller();
            let payment = self.env().transferred_value();

            let content = self.contents.get(content_id).ok_or(Error::ContentNotFound)?;

            if self.subscriptions.contains((content_id, caller)) {
                return Err(Error::SubscriptionAlreadyExists);
            }

            if payment < content.subscription_price {
                return Err(Error::InsufficientPayment);
            }

            // Transfer payment to creator
            self.env()
                .transfer(content.creator, payment)
                .map_err(|_| Error::TransferFailed)?;

            let current_block = self.env().block_number();
            let expiry_block = current_block.saturating_add(content.period_length);

            self.subscriptions.insert(
                (content_id, caller),
                &SubscriptionState { expiry_block },
            );

            self.env().emit_event(SubscriptionCreated {
                content_id,
                subscriber: caller,
                expiry_block,
            });

            Ok(())
        }

        /// Renew an expired subscription. Must send at least the subscription price.
        #[ink(message, payable)]
        pub fn renew_subscription(&mut self, content_id: u32) -> Result<()> {
            let caller = self.env().caller();
            let payment = self.env().transferred_value();

            let content = self.contents.get(content_id).ok_or(Error::ContentNotFound)?;
            let sub = self
                .subscriptions
                .get((content_id, caller))
                .ok_or(Error::SubscriptionNotFound)?;

            let current_block = self.env().block_number();
            if current_block < sub.expiry_block {
                return Err(Error::SubscriptionNotExpired);
            }

            if payment < content.subscription_price {
                return Err(Error::InsufficientPayment);
            }

            self.env()
                .transfer(content.creator, payment)
                .map_err(|_| Error::TransferFailed)?;

            let new_expiry = current_block.saturating_add(content.period_length);
            self.subscriptions.insert(
                (content_id, caller),
                &SubscriptionState {
                    expiry_block: new_expiry,
                },
            );

            self.env().emit_event(SubscriptionRenewed {
                content_id,
                subscriber: caller,
                new_expiry_block: new_expiry,
            });

            Ok(())
        }

        // --------------- Pay-Per-View ---------------

        /// Purchase a view pack. Must send num_views * ppv_price as value.
        #[ink(message, payable)]
        pub fn purchase_views(&mut self, content_id: u32, num_views: u32) -> Result<()> {
            let caller = self.env().caller();
            let payment = self.env().transferred_value();

            let content = self.contents.get(content_id).ok_or(Error::ContentNotFound)?;

            let total_price = content.ppv_price.saturating_mul(U256::from(num_views));
            if payment < total_price {
                return Err(Error::InsufficientPayment);
            }

            self.env()
                .transfer(content.creator, payment)
                .map_err(|_| Error::TransferFailed)?;

            // Add to existing views if user already has a pack
            let existing = self.view_packs.get((content_id, caller));
            let total_views = match existing {
                Some(pack) => pack.views_remaining.saturating_add(num_views),
                None => num_views,
            };

            self.view_packs.insert(
                (content_id, caller),
                &ViewPackState {
                    views_remaining: total_views,
                },
            );

            self.env().emit_event(ViewPackPurchased {
                content_id,
                buyer: caller,
                views: num_views,
            });

            Ok(())
        }

        /// Consume one view from a view pack.
        #[ink(message)]
        pub fn consume_view(&mut self, content_id: u32) -> Result<()> {
            let caller = self.env().caller();

            let mut pack = self
                .view_packs
                .get((content_id, caller))
                .ok_or(Error::ViewPackNotFound)?;

            if pack.views_remaining == 0 {
                return Err(Error::NoViewsRemaining);
            }

            pack.views_remaining = pack.views_remaining.saturating_sub(1);

            if pack.views_remaining == 0 {
                self.view_packs.remove((content_id, caller));
            } else {
                self.view_packs.insert((content_id, caller), &pack);
            }

            self.env().emit_event(ViewConsumed {
                content_id,
                viewer: caller,
                views_remaining: pack.views_remaining,
            });

            Ok(())
        }

        // --------------- Permanent Ownership ---------------

        /// Purchase permanent ownership of content. Must send ownership price as value.
        #[ink(message, payable)]
        pub fn purchase_ownership(&mut self, content_id: u32) -> Result<()> {
            let caller = self.env().caller();
            let payment = self.env().transferred_value();

            let content = self.contents.get(content_id).ok_or(Error::ContentNotFound)?;

            if self.ownership.get((content_id, caller)).unwrap_or(false) {
                return Err(Error::AlreadyOwned);
            }

            if payment < content.ownership_price {
                return Err(Error::InsufficientPayment);
            }

            self.env()
                .transfer(content.creator, payment)
                .map_err(|_| Error::TransferFailed)?;

            self.ownership.insert((content_id, caller), &true);

            self.env().emit_event(OwnershipPurchased {
                content_id,
                buyer: caller,
            });

            Ok(())
        }

        // --------------- Access Verification ---------------

        /// Check whether the caller has access to content.
        /// Returns the type of access right found (or None).
        #[ink(message)]
        pub fn check_access(&self, content_id: u32) -> Result<RightsType> {
            let caller = self.env().caller();

            if !self.contents.contains(content_id) {
                return Err(Error::ContentNotFound);
            }

            // Ownership (permanent, cheapest check)
            if self.ownership.get((content_id, caller)).unwrap_or(false) {
                return Ok(RightsType::Ownership);
            }

            // Active subscription
            if let Some(sub) = self.subscriptions.get((content_id, caller)) {
                let current_block = self.env().block_number();
                if current_block < sub.expiry_block {
                    return Ok(RightsType::Subscription);
                }
            }

            // PPV views remaining
            if let Some(pack) = self.view_packs.get((content_id, caller)) {
                if pack.views_remaining > 0 {
                    return Ok(RightsType::PayPerView);
                }
            }

            Ok(RightsType::None)
        }

        // --------------- Read-only Queries ---------------

        /// Get content info by ID.
        #[ink(message)]
        pub fn get_content(&self, content_id: u32) -> Option<ContentInfo> {
            self.contents.get(content_id)
        }

        /// Get subscription state for a specific user and content.
        #[ink(message)]
        pub fn get_subscription(
            &self,
            content_id: u32,
            subscriber: H160,
        ) -> Option<SubscriptionState> {
            self.subscriptions.get((content_id, subscriber))
        }

        /// Get view pack state for a specific user and content.
        #[ink(message)]
        pub fn get_view_pack(
            &self,
            content_id: u32,
            viewer: H160,
        ) -> Option<ViewPackState> {
            self.view_packs.get((content_id, viewer))
        }

        /// Check if a user owns content permanently.
        #[ink(message)]
        pub fn is_owner(&self, content_id: u32, who: H160) -> bool {
            self.ownership.get((content_id, who)).unwrap_or(false)
        }

        /// Get the next content ID that will be assigned.
        #[ink(message)]
        pub fn next_content_id(&self) -> u32 {
            self.next_content_id
        }
    }

    // ==================== Unit Tests ====================

    #[cfg(test)]
    mod tests {
        use super::*;

        #[ink::test]
        fn register_content_works() {
            let mut contract = RightsManager::new();
            let result = contract.register_content(
                [0u8; 32],
                U256::from(100),  // subscription_price
                U256::from(10),   // ppv_price
                U256::from(500),  // ownership_price
                100,              // period_length
            );
            assert_eq!(result, Ok(0));
            assert_eq!(contract.next_content_id(), 1);

            let info = contract.get_content(0).unwrap();
            assert_eq!(info.subscription_price, U256::from(100));
            assert_eq!(info.ppv_price, U256::from(10));
            assert_eq!(info.ownership_price, U256::from(500));
        }

        #[ink::test]
        fn register_multiple_contents() {
            let mut contract = RightsManager::new();
            assert_eq!(
                contract.register_content([0u8; 32], U256::from(100), U256::from(10), U256::from(500), 100),
                Ok(0)
            );
            assert_eq!(
                contract.register_content([1u8; 32], U256::from(200), U256::from(20), U256::from(1000), 200),
                Ok(1)
            );
            assert_eq!(contract.next_content_id(), 2);
        }

        #[ink::test]
        fn check_access_no_rights() {
            let mut contract = RightsManager::new();
            contract
                .register_content([0u8; 32], U256::from(100), U256::from(10), U256::from(500), 100)
                .unwrap();
            assert_eq!(contract.check_access(0), Ok(RightsType::None));
        }

        #[ink::test]
        fn check_access_content_not_found() {
            let contract = RightsManager::new();
            assert_eq!(contract.check_access(999), Err(Error::ContentNotFound));
        }

        #[ink::test]
        fn consume_view_no_pack() {
            let mut contract = RightsManager::new();
            contract
                .register_content([0u8; 32], U256::from(100), U256::from(10), U256::from(500), 100)
                .unwrap();
            assert_eq!(contract.consume_view(0), Err(Error::ViewPackNotFound));
        }
    }
}

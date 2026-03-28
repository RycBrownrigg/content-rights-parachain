#![cfg_attr(not(feature = "std"), no_std)]

pub use pallet::*;

pub mod types;
pub mod weights;

#[cfg(test)]
mod mock;

#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

#[frame::pallet]
pub mod pallet {
	use frame::prelude::*;
	use polkadot_sdk::pallet_nfts;

	use crate::types::*;
	use crate::weights::WeightInfo as _;

	type BalanceOf<T> =
		<<T as Config>::PaymentCurrency as frame::traits::fungible::Inspect<
			<T as frame_system::Config>::AccountId,
		>>::Balance;

	#[pallet::config]
	pub trait Config:
		frame_system::Config + pallet_nfts::Config<CollectionId = u32, ItemId = u32>
	{
		/// Fungible token for payments (subscriptions, PPV, ownership).
		type PaymentCurrency: frame::traits::fungible::Inspect<Self::AccountId>
			+ frame::traits::fungible::Mutate<Self::AccountId>;

		/// Maximum number of child NFTs per parent.
		#[pallet::constant]
		type MaxChildren: Get<u32>;

		/// Weight information for extrinsics.
		type ContentRightsWeightInfo: crate::weights::WeightInfo;
	}

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	// --------------- Storage ---------------

	/// Auto-incrementing content ID counter.
	#[pallet::storage]
	pub type NextContentId<T> = StorageValue<_, u32, ValueQuery>;

	/// Auto-incrementing item ID counter per collection (for minting child NFTs).
	#[pallet::storage]
	pub type NextItemId<T: Config> = StorageMap<_, Blake2_128Concat, u32, u32, ValueQuery>;

	/// Content ID -> ContentMetadata.
	#[pallet::storage]
	pub type Contents<T: Config> = StorageMap<_, Blake2_128Concat, u32, ContentMetadata<T>>;

	/// (ContentId, AccountId) -> SubscriptionInfo.
	#[pallet::storage]
	pub type Subscriptions<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u32,
		Blake2_128Concat,
		T::AccountId,
		SubscriptionInfo,
	>;

	/// (ContentId, AccountId) -> ViewPackInfo.
	#[pallet::storage]
	pub type ViewPacks<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u32,
		Blake2_128Concat,
		T::AccountId,
		ViewPackInfo,
	>;

	/// (ContentId, AccountId) -> OwnershipInfo. Permanent ownership with NFT tracking.
	#[pallet::storage]
	pub type Ownership<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u32,
		Blake2_128Concat,
		T::AccountId,
		OwnershipInfo,
	>;

	/// Parent (collection, item) -> list of children (collection, item).
	#[pallet::storage]
	pub type Children<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u32,
		Blake2_128Concat,
		u32,
		BoundedVec<(u32, u32), ConstU32<50>>,
		ValueQuery,
	>;

	/// Content ID -> list of royalty splits. If empty, 100% goes to creator.
	#[pallet::storage]
	pub type RoyaltySplits<T: Config> = StorageMap<
		_,
		Blake2_128Concat,
		u32,
		BoundedVec<RoyaltySplit, ConstU32<10>>,
		ValueQuery,
	>;

	/// Child (collection, item) -> parent (collection, item).
	#[pallet::storage]
	pub type Parent<T: Config> =
		StorageDoubleMap<_, Blake2_128Concat, u32, Blake2_128Concat, u32, (u32, u32)>;

	// --------------- Events ---------------

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		ContentRegistered {
			content_id: u32,
			creator: T::AccountId,
			collection_id: u32,
			item_id: u32,
		},
		SubscriptionCreated {
			content_id: u32,
			subscriber: T::AccountId,
			expiry_block: u32,
		},
		SubscriptionRenewed {
			content_id: u32,
			subscriber: T::AccountId,
			new_expiry_block: u32,
		},
		ViewPackPurchased {
			content_id: u32,
			buyer: T::AccountId,
			views: u32,
		},
		ViewConsumed {
			content_id: u32,
			viewer: T::AccountId,
			views_remaining: u32,
		},
		OwnershipPurchased {
			content_id: u32,
			buyer: T::AccountId,
		},
		AccessChecked {
			content_id: u32,
			who: T::AccountId,
			has_access: bool,
		},
		ChildNested {
			parent_collection: u32,
			parent_item: u32,
			child_collection: u32,
			child_item: u32,
		},
		// Cross-chain events (payer ≠ beneficiary)
		CrossChainSubscriptionCreated {
			content_id: u32,
			beneficiary: T::AccountId,
			payer: T::AccountId,
			expiry_block: u32,
		},
		CrossChainSubscriptionRenewed {
			content_id: u32,
			beneficiary: T::AccountId,
			payer: T::AccountId,
			new_expiry_block: u32,
		},
		CrossChainViewPackPurchased {
			content_id: u32,
			beneficiary: T::AccountId,
			payer: T::AccountId,
			views: u32,
		},
		CrossChainOwnershipPurchased {
			content_id: u32,
			beneficiary: T::AccountId,
			payer: T::AccountId,
		},
		OwnershipTransferred {
			content_id: u32,
			from: T::AccountId,
			to: T::AccountId,
		},
		CrossChainOwnershipTransferred {
			content_id: u32,
			from: T::AccountId,
			to: T::AccountId,
			authorizer: T::AccountId,
		},
		RoyaltySplitsUpdated {
			content_id: u32,
			creator: T::AccountId,
			num_splits: u32,
		},
		RoyaltyDistributed {
			content_id: u32,
			recipient: T::AccountId,
			amount: u128,
		},
	}

	// --------------- Errors ---------------

	#[pallet::error]
	pub enum Error<T> {
		ContentNotFound,
		NotContentCreator,
		SubscriptionAlreadyExists,
		SubscriptionNotFound,
		SubscriptionNotExpired,
		ViewPackNotFound,
		NoViewsRemaining,
		AlreadyOwned,
		InsufficientPayment,
		MaxChildrenReached,
		ChildAlreadyNested,
		NftOperationFailed,
		ContentIdOverflow,
		ItemIdOverflow,
		OwnershipNotFound,
		InvalidRoyaltySplits,
	}

	// --------------- Hooks ---------------

	#[pallet::hooks]
	impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {}

	// --------------- Helpers ---------------

	impl<T: Config> Pallet<T> {
		/// Allocate the next collection ID (mirrors pallet-nfts' internal counter).
		fn next_collection_id() -> Result<u32, DispatchError> {
			pallet_nfts::NextCollectionId::<T>::try_mutate(|id| {
				let current = id.unwrap_or(0);
				*id = Some(current.checked_add(1).ok_or(Error::<T>::ContentIdOverflow)?);
				Ok(current)
			})
		}

		/// Mint a child NFT under the content's collection and nest it under the parent.
		fn mint_and_nest_child(
			creator: &T::AccountId,
			owner: &T::AccountId,
			collection_id: u32,
			parent_item_id: u32,
			_rights_type: RightsType,
		) -> Result<u32, DispatchError> {
			let child_item_id = NextItemId::<T>::get(collection_id);
			let next_id = child_item_id.checked_add(1).ok_or(Error::<T>::ItemIdOverflow)?;

			// Mint the child NFT via pallet-nfts public API
			let item_config = pallet_nfts::ItemConfig::default();
			pallet_nfts::Pallet::<T>::do_mint(
				collection_id,
				child_item_id,
				Some(creator.clone()),
				owner.clone(),
				item_config,
				|_, _| Ok(()),
			)?;

			// Set rights_type attribute via the dispatchable (do_set_attribute is pub(crate))
			let rights_key: BoundedVec<u8, <T as pallet_nfts::Config>::KeyLimit> =
				b"rights_type"
					.to_vec()
					.try_into()
					.map_err(|_| Error::<T>::NftOperationFailed)?;
			let rights_value: BoundedVec<u8, <T as pallet_nfts::Config>::ValueLimit> =
				_rights_type
					.encode()
					.try_into()
					.map_err(|_| Error::<T>::NftOperationFailed)?;

			// Use the dispatchable set_attribute with a signed origin from the creator
			let creator_origin: T::RuntimeOrigin =
				frame_system::RawOrigin::Signed(creator.clone()).into();
			pallet_nfts::Pallet::<T>::set_attribute(
				creator_origin,
				collection_id,
				Some(child_item_id),
				pallet_nfts::AttributeNamespace::CollectionOwner,
				rights_key,
				rights_value,
			)?;

			// Update nesting index
			Children::<T>::try_mutate(collection_id, parent_item_id, |children| {
				children
					.try_push((collection_id, child_item_id))
					.map_err(|_| Error::<T>::MaxChildrenReached)
			})?;
			Parent::<T>::insert(collection_id, child_item_id, (collection_id, parent_item_id));

			NextItemId::<T>::insert(collection_id, next_id);

			Self::deposit_event(Event::ChildNested {
				parent_collection: collection_id,
				parent_item: parent_item_id,
				child_collection: collection_id,
				child_item: child_item_id,
			});

			Ok(child_item_id)
		}

		/// Transfer funds from buyer, distributing according to royalty splits.
		/// If no splits are configured, 100% goes to the creator.
		fn pay_with_royalties(
			from: &T::AccountId,
			creator: &T::AccountId,
			content_id: u32,
			amount: u128,
		) -> DispatchResult {
			let splits = RoyaltySplits::<T>::get(content_id);

			if splits.is_empty() {
				// No splits — 100% to creator (original behavior)
				Self::transfer_amount(from, creator, amount)?;
			} else {
				// Distribute according to splits
				let mut distributed: u128 = 0;
				for split in splits.iter() {
					let share = amount
						.saturating_mul(split.basis_points as u128)
						.saturating_div(10_000);
					if share > 0 {
						// Decode recipient from raw bytes
						let recipient = T::AccountId::decode(&mut &split.recipient[..])
							.map_err(|_| Error::<T>::InvalidRoyaltySplits)?;
						Self::transfer_amount(from, &recipient, share)?;
						distributed = distributed.saturating_add(share);

						Self::deposit_event(Event::RoyaltyDistributed {
							content_id,
							recipient,
							amount: share,
						});
					}
				}
				// Remainder to creator (handles rounding)
				let remainder = amount.saturating_sub(distributed);
				if remainder > 0 {
					Self::transfer_amount(from, creator, remainder)?;
				}
			}

			Ok(())
		}

		/// Low-level transfer helper.
		fn transfer_amount(
			from: &T::AccountId,
			to: &T::AccountId,
			amount: u128,
		) -> DispatchResult {
			let amount_balance: BalanceOf<T> =
				amount.try_into().map_err(|_| Error::<T>::InsufficientPayment)?;
			<T::PaymentCurrency as frame::traits::fungible::Mutate<T::AccountId>>::transfer(
				from,
				to,
				amount_balance,
				frame::traits::tokens::Preservation::Preserve,
			)?;
			Ok(())
		}
	}

	// --------------- Extrinsics ---------------

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Register new content. Creates an NFT collection and mints item #0 as the parent
		/// "Content NFT".
		#[pallet::call_index(0)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::register_content())]
		pub fn register_content(
			origin: OriginFor<T>,
			metadata_hash: [u8; 32],
			title: BoundedVec<u8, ConstU32<128>>,
			subscription_price: u128,
			ppv_price: u128,
			ownership_price: u128,
			period_length: u32,
		) -> DispatchResult {
			let creator = ensure_signed(origin)?;

			let content_id = NextContentId::<T>::get();
			let next_content_id =
				content_id.checked_add(1).ok_or(Error::<T>::ContentIdOverflow)?;

			// Allocate a collection ID and create the NFT collection
			let collection_id = Self::next_collection_id()?;
			let collection_config = pallet_nfts::CollectionConfigFor::<T> {
				settings: Default::default(),
				max_supply: None,
				mint_settings: Default::default(),
			};
			pallet_nfts::Pallet::<T>::do_create_collection(
				collection_id,
				creator.clone(),
				creator.clone(),
				collection_config,
				T::CollectionDeposit::get(),
				pallet_nfts::Event::Created {
					collection: collection_id,
					creator: creator.clone(),
					owner: creator.clone(),
				},
			)?;

			// Mint item #0 as the parent "Content NFT"
			let parent_item_id: u32 = 0;
			let item_config = pallet_nfts::ItemConfig::default();
			pallet_nfts::Pallet::<T>::do_mint(
				collection_id,
				parent_item_id,
				Some(creator.clone()),
				creator.clone(),
				item_config,
				|_, _| Ok(()),
			)?;

			// Store content metadata
			let metadata = ContentMetadata::<T> {
				creator: creator.clone(),
				metadata_hash,
				collection_id,
				content_item_id: parent_item_id,
				title,
				subscription_price,
				ppv_price,
				ownership_price,
				period_length,
			};
			Contents::<T>::insert(content_id, metadata);
			NextContentId::<T>::put(next_content_id);

			// Item IDs start at 1 (0 is the parent)
			NextItemId::<T>::insert(collection_id, 1u32);

			Self::deposit_event(Event::ContentRegistered {
				content_id,
				creator,
				collection_id,
				item_id: parent_item_id,
			});

			Ok(())
		}

		/// Subscribe to content. Pays the creator and mints a Subscription child NFT.
		#[pallet::call_index(1)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::subscribe())]
		pub fn subscribe(origin: OriginFor<T>, content_id: u32) -> DispatchResult {
			let subscriber = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
			ensure!(
				!Subscriptions::<T>::contains_key(content_id, &subscriber),
				Error::<T>::SubscriptionAlreadyExists
			);

			Self::pay_with_royalties(&subscriber, &content.creator, content_id, content.subscription_price)?;

			let child_item_id = Self::mint_and_nest_child(
				&content.creator,
				&subscriber,
				content.collection_id,
				content.content_item_id,
				RightsType::Subscription,
			)?;

			let current_block: u32 = <frame_system::Pallet<T>>::block_number()
				.try_into()
				.unwrap_or(0u32);
			let expiry_block = current_block.saturating_add(content.period_length);

			Subscriptions::<T>::insert(
				content_id,
				&subscriber,
				SubscriptionInfo {
					expiry_block,
					auto_renew: false,
					child_item_id,
				},
			);

			Self::deposit_event(Event::SubscriptionCreated {
				content_id,
				subscriber,
				expiry_block,
			});

			Ok(())
		}

		/// Renew an expired subscription.
		#[pallet::call_index(2)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::renew_subscription())]
		pub fn renew_subscription(origin: OriginFor<T>, content_id: u32) -> DispatchResult {
			let subscriber = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
			let sub = Subscriptions::<T>::get(content_id, &subscriber)
				.ok_or(Error::<T>::SubscriptionNotFound)?;

			let current_block: u32 = <frame_system::Pallet<T>>::block_number()
				.try_into()
				.unwrap_or(0u32);
			ensure!(current_block >= sub.expiry_block, Error::<T>::SubscriptionNotExpired);

			Self::pay_with_royalties(&subscriber, &content.creator, content_id, content.subscription_price)?;

			let new_expiry = current_block.saturating_add(content.period_length);
			Subscriptions::<T>::mutate(content_id, &subscriber, |maybe_sub| {
				if let Some(s) = maybe_sub {
					s.expiry_block = new_expiry;
				}
			});

			Self::deposit_event(Event::SubscriptionRenewed {
				content_id,
				subscriber,
				new_expiry_block: new_expiry,
			});

			Ok(())
		}

		/// Purchase a pay-per-view pack.
		#[pallet::call_index(3)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::purchase_views())]
		pub fn purchase_views(
			origin: OriginFor<T>,
			content_id: u32,
			num_views: u32,
		) -> DispatchResult {
			let buyer = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;

			let total_price = content
				.ppv_price
				.checked_mul(num_views as u128)
				.ok_or(Error::<T>::InsufficientPayment)?;
			Self::pay_with_royalties(&buyer, &content.creator, content_id, total_price)?;

			let child_item_id = Self::mint_and_nest_child(
				&content.creator,
				&buyer,
				content.collection_id,
				content.content_item_id,
				RightsType::PayPerView,
			)?;

			ViewPacks::<T>::insert(
				content_id,
				&buyer,
				ViewPackInfo {
					views_remaining: num_views,
					child_item_id,
				},
			);

			Self::deposit_event(Event::ViewPackPurchased {
				content_id,
				buyer,
				views: num_views,
			});

			Ok(())
		}

		/// Consume one view from a pay-per-view pack.
		#[pallet::call_index(4)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::consume_view())]
		pub fn consume_view(origin: OriginFor<T>, content_id: u32) -> DispatchResult {
			let viewer = ensure_signed(origin)?;

			let mut pack =
				ViewPacks::<T>::get(content_id, &viewer).ok_or(Error::<T>::ViewPackNotFound)?;
			ensure!(pack.views_remaining > 0, Error::<T>::NoViewsRemaining);

			pack.views_remaining = pack.views_remaining.saturating_sub(1);

			if pack.views_remaining == 0 {
				let content =
					Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
				// Burn the child NFT
				let _ = pallet_nfts::Pallet::<T>::do_burn(
					content.collection_id,
					pack.child_item_id,
					|_| Ok(()),
				);
				// Clean up nesting index
				Children::<T>::mutate(
					content.collection_id,
					content.content_item_id,
					|children| {
						children.retain(|&(_, item)| item != pack.child_item_id);
					},
				);
				Parent::<T>::remove(content.collection_id, pack.child_item_id);
				ViewPacks::<T>::remove(content_id, &viewer);
			} else {
				ViewPacks::<T>::insert(content_id, &viewer, pack.clone());
			}

			Self::deposit_event(Event::ViewConsumed {
				content_id,
				viewer,
				views_remaining: pack.views_remaining,
			});

			Ok(())
		}

		/// Purchase permanent ownership of content.
		#[pallet::call_index(5)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::purchase_ownership())]
		pub fn purchase_ownership(origin: OriginFor<T>, content_id: u32) -> DispatchResult {
			let buyer = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
			ensure!(
				!Ownership::<T>::contains_key(content_id, &buyer),
				Error::<T>::AlreadyOwned
			);

			Self::pay_with_royalties(&buyer, &content.creator, content_id, content.ownership_price)?;

			let child_item_id = Self::mint_and_nest_child(
				&content.creator,
				&buyer,
				content.collection_id,
				content.content_item_id,
				RightsType::Ownership,
			)?;

			Ownership::<T>::insert(content_id, &buyer, OwnershipInfo { child_item_id });

			Self::deposit_event(Event::OwnershipPurchased {
				content_id,
				buyer,
			});

			Ok(())
		}

		/// Check whether a user has access to content (subscription, PPV, or ownership).
		#[pallet::call_index(6)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::check_access())]
		pub fn check_access(origin: OriginFor<T>, content_id: u32) -> DispatchResult {
			let who = ensure_signed(origin)?;

			ensure!(
				Contents::<T>::contains_key(content_id),
				Error::<T>::ContentNotFound
			);

			// Check ownership first (cheapest)
			if Ownership::<T>::contains_key(content_id, &who) {
				Self::deposit_event(Event::AccessChecked {
					content_id,
					who,
					has_access: true,
				});
				return Ok(());
			}

			// Check active subscription
			if let Some(sub) = Subscriptions::<T>::get(content_id, &who) {
				let current_block: u32 = <frame_system::Pallet<T>>::block_number()
					.try_into()
					.unwrap_or(0u32);
				if current_block < sub.expiry_block {
					Self::deposit_event(Event::AccessChecked {
						content_id,
						who,
						has_access: true,
					});
					return Ok(());
				}
			}

			// Check PPV views
			if let Some(pack) = ViewPacks::<T>::get(content_id, &who) {
				if pack.views_remaining > 0 {
					Self::deposit_event(Event::AccessChecked {
						content_id,
						who,
						has_access: true,
					});
					return Ok(());
				}
			}

			Self::deposit_event(Event::AccessChecked {
				content_id,
				who,
				has_access: false,
			});

			Ok(())
		}

		// --------------- Cross-Chain (XCM) Extrinsics ---------------
		//
		// These extrinsics decouple the **payer** (origin) from the **beneficiary**.
		// When a sibling parachain sends an XCM `Transact`, the origin becomes the
		// sovereign account of that parachain (via SovereignSignedViaLocation).
		// The sovereign account pays, but the rights token is granted to the
		// specified beneficiary — the actual user on the remote chain.

		/// Cross-chain subscribe: payer (origin) pays, beneficiary gets the subscription.
		#[pallet::call_index(7)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::xcm_subscribe())]
		pub fn xcm_subscribe(
			origin: OriginFor<T>,
			content_id: u32,
			beneficiary: T::AccountId,
		) -> DispatchResult {
			let payer = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
			ensure!(
				!Subscriptions::<T>::contains_key(content_id, &beneficiary),
				Error::<T>::SubscriptionAlreadyExists
			);

			Self::pay_with_royalties(&payer, &content.creator, content_id, content.subscription_price)?;

			let child_item_id = Self::mint_and_nest_child(
				&content.creator,
				&beneficiary,
				content.collection_id,
				content.content_item_id,
				RightsType::Subscription,
			)?;

			let current_block: u32 = <frame_system::Pallet<T>>::block_number()
				.try_into()
				.unwrap_or(0u32);
			let expiry_block = current_block.saturating_add(content.period_length);

			Subscriptions::<T>::insert(
				content_id,
				&beneficiary,
				SubscriptionInfo {
					expiry_block,
					auto_renew: false,
					child_item_id,
				},
			);

			Self::deposit_event(Event::CrossChainSubscriptionCreated {
				content_id,
				beneficiary,
				payer,
				expiry_block,
			});

			Ok(())
		}

		/// Cross-chain renew: payer (origin) pays, beneficiary's subscription is renewed.
		#[pallet::call_index(8)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::xcm_renew_subscription())]
		pub fn xcm_renew_subscription(
			origin: OriginFor<T>,
			content_id: u32,
			beneficiary: T::AccountId,
		) -> DispatchResult {
			let payer = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
			let sub = Subscriptions::<T>::get(content_id, &beneficiary)
				.ok_or(Error::<T>::SubscriptionNotFound)?;

			let current_block: u32 = <frame_system::Pallet<T>>::block_number()
				.try_into()
				.unwrap_or(0u32);
			ensure!(current_block >= sub.expiry_block, Error::<T>::SubscriptionNotExpired);

			Self::pay_with_royalties(&payer, &content.creator, content_id, content.subscription_price)?;

			let new_expiry = current_block.saturating_add(content.period_length);
			Subscriptions::<T>::mutate(content_id, &beneficiary, |maybe_sub| {
				if let Some(s) = maybe_sub {
					s.expiry_block = new_expiry;
				}
			});

			Self::deposit_event(Event::CrossChainSubscriptionRenewed {
				content_id,
				beneficiary,
				payer,
				new_expiry_block: new_expiry,
			});

			Ok(())
		}

		/// Cross-chain purchase views: payer (origin) pays, beneficiary gets the view pack.
		#[pallet::call_index(9)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::xcm_purchase_views())]
		pub fn xcm_purchase_views(
			origin: OriginFor<T>,
			content_id: u32,
			beneficiary: T::AccountId,
			num_views: u32,
		) -> DispatchResult {
			let payer = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;

			let total_price = content
				.ppv_price
				.checked_mul(num_views as u128)
				.ok_or(Error::<T>::InsufficientPayment)?;
			Self::pay_with_royalties(&payer, &content.creator, content_id, total_price)?;

			let child_item_id = Self::mint_and_nest_child(
				&content.creator,
				&beneficiary,
				content.collection_id,
				content.content_item_id,
				RightsType::PayPerView,
			)?;

			ViewPacks::<T>::insert(
				content_id,
				&beneficiary,
				ViewPackInfo {
					views_remaining: num_views,
					child_item_id,
				},
			);

			Self::deposit_event(Event::CrossChainViewPackPurchased {
				content_id,
				beneficiary,
				payer,
				views: num_views,
			});

			Ok(())
		}

		/// Cross-chain purchase ownership: payer (origin) pays, beneficiary gets permanent access.
		#[pallet::call_index(10)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::xcm_purchase_ownership())]
		pub fn xcm_purchase_ownership(
			origin: OriginFor<T>,
			content_id: u32,
			beneficiary: T::AccountId,
		) -> DispatchResult {
			let payer = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
			ensure!(
				!Ownership::<T>::contains_key(content_id, &beneficiary),
				Error::<T>::AlreadyOwned
			);

			Self::pay_with_royalties(&payer, &content.creator, content_id, content.ownership_price)?;

			let child_item_id = Self::mint_and_nest_child(
				&content.creator,
				&beneficiary,
				content.collection_id,
				content.content_item_id,
				RightsType::Ownership,
			)?;

			Ownership::<T>::insert(content_id, &beneficiary, OwnershipInfo { child_item_id });

			Self::deposit_event(Event::CrossChainOwnershipPurchased {
				content_id,
				beneficiary,
				payer,
			});

			Ok(())
		}

		/// Transfer permanent ownership to another account. The caller must own the content.
		/// No payment to the creator — this is a peer-to-peer secondary market transfer.
		#[pallet::call_index(11)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::transfer_ownership())]
		pub fn transfer_ownership(
			origin: OriginFor<T>,
			content_id: u32,
			to: T::AccountId,
		) -> DispatchResult {
			let from = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
			let ownership_info =
				Ownership::<T>::get(content_id, &from).ok_or(Error::<T>::OwnershipNotFound)?;
			ensure!(
				!Ownership::<T>::contains_key(content_id, &to),
				Error::<T>::AlreadyOwned
			);

			// Burn old owner's child NFT
			let _ = pallet_nfts::Pallet::<T>::do_burn(
				content.collection_id,
				ownership_info.child_item_id,
				|_| Ok(()),
			);
			Children::<T>::mutate(
				content.collection_id,
				content.content_item_id,
				|children| {
					children.retain(|&(_, item)| item != ownership_info.child_item_id);
				},
			);
			Parent::<T>::remove(content.collection_id, ownership_info.child_item_id);

			// Mint new child NFT for recipient
			let new_child_item_id = Self::mint_and_nest_child(
				&content.creator,
				&to,
				content.collection_id,
				content.content_item_id,
				RightsType::Ownership,
			)?;

			// Update ownership storage
			Ownership::<T>::remove(content_id, &from);
			Ownership::<T>::insert(
				content_id,
				&to,
				OwnershipInfo {
					child_item_id: new_child_item_id,
				},
			);

			Self::deposit_event(Event::OwnershipTransferred {
				content_id,
				from,
				to,
			});

			Ok(())
		}

		/// Cross-chain ownership transfer: authorizer (sovereign account) transfers
		/// ownership from one user to another. The `from` account must currently own
		/// the content.
		#[pallet::call_index(12)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::xcm_transfer_ownership())]
		pub fn xcm_transfer_ownership(
			origin: OriginFor<T>,
			content_id: u32,
			from: T::AccountId,
			to: T::AccountId,
		) -> DispatchResult {
			let authorizer = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
			let ownership_info =
				Ownership::<T>::get(content_id, &from).ok_or(Error::<T>::OwnershipNotFound)?;
			ensure!(
				!Ownership::<T>::contains_key(content_id, &to),
				Error::<T>::AlreadyOwned
			);

			// Burn old owner's child NFT
			let _ = pallet_nfts::Pallet::<T>::do_burn(
				content.collection_id,
				ownership_info.child_item_id,
				|_| Ok(()),
			);
			Children::<T>::mutate(
				content.collection_id,
				content.content_item_id,
				|children| {
					children.retain(|&(_, item)| item != ownership_info.child_item_id);
				},
			);
			Parent::<T>::remove(content.collection_id, ownership_info.child_item_id);

			// Mint new child NFT for recipient
			let new_child_item_id = Self::mint_and_nest_child(
				&content.creator,
				&to,
				content.collection_id,
				content.content_item_id,
				RightsType::Ownership,
			)?;

			// Update ownership storage
			Ownership::<T>::remove(content_id, &from);
			Ownership::<T>::insert(
				content_id,
				&to,
				OwnershipInfo {
					child_item_id: new_child_item_id,
				},
			);

			Self::deposit_event(Event::CrossChainOwnershipTransferred {
				content_id,
				from,
				to,
				authorizer,
			});

			Ok(())
		}

		/// Set royalty splits for content. Only the creator can call this.
		/// Splits are in basis points (out of 10,000). The creator receives the
		/// remainder after all splits are distributed. Total splits must be <= 10,000.
		#[pallet::call_index(13)]
		#[pallet::weight(<T as Config>::ContentRightsWeightInfo::register_content())]
		pub fn set_royalty_splits(
			origin: OriginFor<T>,
			content_id: u32,
			splits: BoundedVec<RoyaltySplit, ConstU32<10>>,
		) -> DispatchResult {
			let caller = ensure_signed(origin)?;

			let content = Contents::<T>::get(content_id).ok_or(Error::<T>::ContentNotFound)?;
			ensure!(caller == content.creator, Error::<T>::NotContentCreator);

			// Validate total basis points <= 10,000
			let total_bp: u32 = splits.iter().map(|s| s.basis_points as u32).sum();
			ensure!(total_bp <= 10_000, Error::<T>::InvalidRoyaltySplits);

			let num_splits = splits.len() as u32;
			RoyaltySplits::<T>::insert(content_id, splits);

			Self::deposit_event(Event::RoyaltySplitsUpdated {
				content_id,
				creator: caller,
				num_splits,
			});

			Ok(())
		}
	}
}

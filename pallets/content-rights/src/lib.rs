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

	/// (ContentId, AccountId) -> bool. Permanent ownership.
	#[pallet::storage]
	pub type Ownership<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u32,
		Blake2_128Concat,
		T::AccountId,
		bool,
		ValueQuery,
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

		/// Transfer funds from buyer to creator.
		fn pay(
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

			Self::pay(&subscriber, &content.creator, content.subscription_price)?;

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

			Self::pay(&subscriber, &content.creator, content.subscription_price)?;

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
			Self::pay(&buyer, &content.creator, total_price)?;

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
				!Ownership::<T>::get(content_id, &buyer),
				Error::<T>::AlreadyOwned
			);

			Self::pay(&buyer, &content.creator, content.ownership_price)?;

			Self::mint_and_nest_child(
				&content.creator,
				&buyer,
				content.collection_id,
				content.content_item_id,
				RightsType::Ownership,
			)?;

			Ownership::<T>::insert(content_id, &buyer, true);

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
			if Ownership::<T>::get(content_id, &who) {
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
	}
}

#![cfg_attr(not(feature = "std"), no_std)]

#[ink::contract]
mod flipper {
    #[ink(storage)]
    pub struct Flipper {
        value: bool,
    }

    impl Flipper {
        /// Creates a new flipper smart contract initialized to `false`.
        #[ink(constructor)]
        pub fn new() -> Self {
            Self { value: false }
        }

        /// Creates a new flipper smart contract initialized to `init_value`.
        #[ink(constructor)]
        pub fn new_init(init_value: bool) -> Self {
            Self { value: init_value }
        }

        /// Flips the current value of the boolean.
        #[ink(message)]
        pub fn flip(&mut self) {
            self.value = !self.value;
        }

        /// Returns the current value of the boolean.
        #[ink(message)]
        pub fn get(&self) -> bool {
            self.value
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[ink::test]
        fn default_works() {
            let flipper = Flipper::new();
            assert!(!flipper.get());
        }

        #[ink::test]
        fn flip_works() {
            let mut flipper = Flipper::new_init(false);
            assert!(!flipper.get());
            flipper.flip();
            assert!(flipper.get());
        }
    }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/app', '<rootDir>/src'],
  // The first render in a suite pays for transforming React Native; later ones are fast.
  testTimeout: 30000,
  setupFiles: ['<rootDir>/src/polyfills.ts', '<rootDir>/src/components/jest-setup.ts'],
  // pnpm keeps packages under node_modules/.pnpm; React Native and Expo ship untranspiled code.
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@gorhom/.*|react-native-svg|@slicerx/.*))',
  ],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
}

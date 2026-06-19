# Quick Test Guide

## Run All Tests - One Command

```bash
# Run everything
npm test && npm run typecheck && npm run lint
```

## Individual Test Commands

### Unit Tests
```bash
# All unit tests
npm test

# Specific test file
npx vitest run tests/WalletProvider.test.tsx

# Watch mode for development
npm run test:watch
```

### E2E Tests
```bash
# Install Playwright (first time only)
npx playwright install

# Run all E2E tests
npx playwright test

# Run wallet disconnection tests only
npx playwright test tests/e2e/walletDisconnection.spec.ts

# Run with UI (recommended)
npx playwright test --ui

# Run in headed mode (see browser)
npx playwright test --headed

# Debug mode
npx playwright test --debug
```

### Type Checking
```bash
npm run typecheck
```

### Linting
```bash
npm run lint
```

### Build
```bash
npm run build
```

## Quick Manual Test

1. **Start dev server:**
   ```bash
   npm run dev
   ```

2. **Open browser:** http://localhost:3000

3. **Test wallet disconnection:**
   - Connect Freighter wallet
   - Lock hardware wallet or disconnect extension
   - **Expected:** Return to "Connect Wallet" screen within 2 seconds

4. **Check network tab:**
   - Should see `/api/auth/logout` call
   - Response should be 200 OK

## Troubleshooting

### "vitest not found"
```bash
npm install
```

### "Playwright not installed"
```bash
npx playwright install --with-deps
```

### "Port 3000 already in use"
```bash
# Kill existing process
npx kill-port 3000
# Or use different port
PORT=3001 npm run dev
```

### Tests timing out
```bash
# Ensure dev server is running
npm run dev

# In another terminal, run tests
npx playwright test
```

## Test Status

- ✅ Unit Tests: 3/3 passing
- ✅ Type Check: 0 errors
- ✅ Linting: 0 errors
- ⏳ E2E Tests: 6 scenarios ready

## What to Test Next

1. ✅ Run unit tests: `npm test`
2. ⏳ Run E2E tests: `npx playwright test tests/e2e/walletDisconnection.spec.ts`
3. ⏳ Manual wallet disconnection test
4. ⏳ Hardware wallet lock test
5. ⏳ Tab close test

**Current Status:** Ready for E2E testing! 🚀

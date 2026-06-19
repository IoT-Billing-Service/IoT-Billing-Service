# Wallet Session Security Fix - Deployment Checklist

## 🎯 Issue Summary
**Critical Security Vulnerability:** 30-second window between wallet disconnection and session termination allowed potential unauthorized transaction execution.

**Solution Implemented:** Event-driven wallet monitoring with <2-second disconnection detection + backend heartbeat mechanism.

---

## ✅ Implementation Status

### Code Changes
- ✅ **WalletProvider.tsx** - Event-driven disconnection detection
- ✅ **sessionMonitor.ts** - Heartbeat-based session management
- ✅ **useWeb3Auth.ts** - Integrated session lifecycle
- ✅ **API Auth Routes** - Complete backend authentication system
  - ✅ `/api/auth/nonce` - Nonce generation
  - ✅ `/api/auth/verify` - Signature verification
  - ✅ `/api/auth/logout` - Session termination
  - ✅ `/api/auth/heartbeat` - Session validation
  - ✅ `sessionStore.ts` - Shared session management

### Tests
- ✅ **Unit Tests** - 3/3 passing (WalletProvider.test.tsx)
- ⏳ **E2E Tests** - 6 scenarios created (walletDisconnection.spec.ts)
- ✅ **Type Checking** - No TypeScript errors
- ⏳ **Manual Testing** - Awaiting execution

### Documentation
- ✅ **SECURITY_FIX_SUMMARY.md** - Complete implementation details
- ✅ **E2E_TEST_GUIDE.md** - E2E testing instructions
- ✅ **This checklist** - Deployment guide

---

## 📋 Pre-Deployment Checklist

### 1. Local Testing
- [x] Unit tests passing: `npm test`
- [x] Type checking passing: `npm run typecheck`
- [ ] E2E tests passing: `npx playwright test tests/e2e/walletDisconnection.spec.ts`
- [ ] Manual wallet disconnection testing
- [ ] Manual hardware wallet lock testing
- [ ] Manual tab close testing

### 2. Code Quality
- [x] No TypeScript errors
- [x] No linting errors: `npm run lint`
- [x] Code formatted: `npm run format`
- [x] All files properly documented

### 3. Environment Configuration
- [ ] `JWT_SECRET` environment variable set
- [ ] Redis connection configured (for production)
- [ ] Rate limiting configured on auth endpoints
- [ ] HTTPS enabled (for sendBeacon)
- [ ] CORS properly configured

### 4. Security Review
- [ ] Session timeout behavior verified
- [ ] Heartbeat mechanism stress tested
- [ ] Token replay attack prevention validated
- [ ] Hardware wallet lock detection confirmed
- [ ] Tab close cleanup working across browsers
- [ ] XSS/CSRF protections in place
- [ ] Input validation on all auth endpoints

### 5. Performance Testing
- [ ] Heartbeat network overhead measured
- [ ] Memory usage of session store monitored
- [ ] Cache clearing performance validated
- [ ] Concurrent session limit tested

---

## 🚀 Deployment Steps

### Step 1: Staging Environment

```bash
# 1. Push to staging branch
git checkout staging
git merge feature/wallet-security-fix
git push origin staging

# 2. Deploy to staging
npm run build
npm run start  # or your deployment command

# 3. Run E2E tests against staging
npx playwright test tests/e2e/walletDisconnection.spec.ts --headed

# 4. Manual testing on staging
# - Connect wallet
# - Lock hardware wallet
# - Verify < 2-second response
# - Check network logs for /api/auth/logout

# 5. Load testing
# - Simulate concurrent sessions
# - Monitor heartbeat endpoint performance
```

### Step 2: Production Environment

⚠️ **ONLY proceed if ALL staging tests pass**

```bash
# 1. Ensure environment variables are set
echo $JWT_SECRET  # Should be set
# If not set:
# export JWT_SECRET=<strong-random-secret>

# 2. Replace in-memory stores with Redis
# Update src/app/api/auth/sessionStore.ts with Redis client

# 3. Enable rate limiting
# Add rate limiting middleware to auth routes

# 4. Build for production
npm run build

# 5. Deploy to production
# Use your production deployment process

# 6. Monitor initial rollout
# - Watch for auth errors
# - Monitor heartbeat success rate
# - Track session timeout metrics
# - Alert on anomalies
```

### Step 3: Post-Deployment Verification

```bash
# 1. Smoke tests
curl https://your-domain.com/api/auth/nonce?publicKey=GXXX...

# 2. Monitor logs for errors
# Check application logs for auth failures

# 3. Verify metrics
# - Session creation rate
# - Logout call frequency
# - Heartbeat success rate

# 4. User acceptance testing
# Have team members test wallet connections
```

---

## 🔧 Production Configuration

### Required Environment Variables

```bash
# JWT Secret (REQUIRED)
JWT_SECRET=<generate-with-openssl-rand-hex-64>

# Redis Configuration (REQUIRED for production)
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=<your-redis-password>

# Session Configuration (optional, uses defaults)
SESSION_TIMEOUT=86400000  # 24 hours in ms
HEARTBEAT_INTERVAL=55000  # 55 seconds
HEARTBEAT_TIMEOUT=60000   # 60 seconds

# Rate Limiting (recommended)
RATE_LIMIT_WINDOW=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100
```

### Redis Setup (Production)

Replace the in-memory store in `sessionStore.ts`:

```typescript
import { createClient } from 'redis';

const redis = createClient({
  url: process.env.REDIS_URL,
  password: process.env.REDIS_PASSWORD,
});

await redis.connect();

export const sessionStore = {
  async set(key: string, value: SessionEntry) {
    await redis.setEx(
      `session:${key}`,
      Math.floor((value.expiresAt - Date.now()) / 1000),
      JSON.stringify(value)
    );
  },
  
  async get(key: string): Promise<SessionEntry | null> {
    const data = await redis.get(`session:${key}`);
    return data ? JSON.parse(data) : null;
  },
  
  async delete(key: string) {
    await redis.del(`session:${key}`);
  },
};
```

### Rate Limiting Setup

Add to auth route handlers:

```typescript
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
  message: 'Too many authentication attempts, please try again later',
});

// Apply to routes
export async function POST(request: NextRequest) {
  // Rate limiting logic here
  // ...
}
```

---

## 📊 Monitoring & Alerting

### Key Metrics to Monitor

1. **Session Metrics**
   - Active session count
   - Session creation rate
   - Session timeout rate
   - Average session duration

2. **Heartbeat Metrics**
   - Heartbeat request rate
   - Heartbeat success rate
   - Heartbeat failure reasons
   - Average heartbeat latency

3. **Disconnection Metrics**
   - Disconnection event frequency
   - Time-to-logout distribution
   - Failed logout attempts
   - Cache clear performance

4. **Security Metrics**
   - Invalid nonce attempts
   - Signature verification failures
   - Replay attack attempts
   - Rate limit hits

### Alerts to Configure

- 🚨 **Critical:** Heartbeat success rate < 95%
- 🚨 **Critical:** Session timeout rate > 10%
- ⚠️ **Warning:** Logout API failures > 5%
- ⚠️ **Warning:** Average disconnection time > 1.5s
- ℹ️ **Info:** Rate limit triggered

---

## 🐛 Troubleshooting

### Issue: Sessions timing out immediately

**Possible causes:**
- JWT secret mismatch between environments
- System clock skew
- Heartbeat interval too long

**Solution:**
```bash
# Check JWT secret is set
echo $JWT_SECRET

# Verify system time is synchronized
timedatectl status

# Check heartbeat configuration
grep HEARTBEAT .env
```

### Issue: Wallet disconnection not detected

**Possible causes:**
- WatchWalletChanges not initialized
- Polling interval too long
- Event listener not properly attached

**Solution:**
```bash
# Check browser console for errors
# Verify WatchWalletChanges is created in useEffect
# Reduce polling interval temporarily for testing
```

### Issue: High heartbeat failure rate

**Possible causes:**
- Network latency
- Backend overload
- Session store connection issues

**Solution:**
```bash
# Check Redis/session store connectivity
redis-cli ping

# Monitor backend response times
# Consider increasing heartbeat timeout
```

---

## 🔄 Rollback Plan

If critical issues arise after deployment:

### Immediate Rollback
```bash
# 1. Revert to previous version
git revert HEAD
git push origin main

# 2. Deploy previous version
npm run build
npm run start

# 3. Verify service is restored
curl https://your-domain.com/health
```

### Partial Rollback
If only specific components are problematic:

1. **Disable heartbeat only:** Set `HEARTBEAT_INTERVAL=300000` (5 minutes)
2. **Revert to polling:** Temporarily revert `WalletProvider.tsx` changes
3. **Disable auth routes:** Add feature flag to bypass new auth flow

---

## 📞 Support Contacts

- **Security Team:** security@yourcompany.com
- **DevOps Team:** devops@yourcompany.com
- **On-call Engineer:** +1-XXX-XXX-XXXX

---

## ✅ Sign-off

Before deploying to production, obtain sign-off from:

- [ ] Lead Developer: _______________
- [ ] Security Officer: _______________
- [ ] DevOps Lead: _______________
- [ ] Product Manager: _______________

---

**Deployment Date:** _______________  
**Deployed By:** _______________  
**Version:** 1.0.0  
**Status:** 🟡 Ready for Staging

# GitHub Issues to Create for Relation Conflicts

**⚠️ ACTION REQUIRED**: Please create these 3 GitHub issues manually.

Based on the `/validate` endpoint results, the following GitHub issues need to be created in the repository:

---

## Issue 1: Chain 1287 (Moonbase Alpha)

**Title:** `[Data Validation] Relation conflict for chain 1287 (Moonbase Alpha)`

**Labels:** `data-validation`, `relation-conflict`, `automated`

**Body:**
```markdown
## Relation Conflict Detected

**Chain ID:** 1287
**Chain Name:** Moonbase Alpha
**Conflict Type:** relation_source_conflict
**Message:** Chain 1287 (Moonbase Alpha) has testnetOf relation in theGraph but isTestnet=false in chainlist

### The Graph Relation
- **Kind:** testnetOf
- **Network:** moonbeam
- **Chain ID:** 1284
- **Source:** theGraph

### Chainlist Data
- **isTestnet:** false

---
This issue was automatically created by the data validation system.
Rule: Rule 1 - Relation Conflicts
```

---

## Issue 2: Chain 33111 (Curtis)

**Title:** `[Data Validation] Relation conflict for chain 33111 (Curtis)`

**Labels:** `data-validation`, `relation-conflict`, `automated`

**Body:**
```markdown
## Relation Conflict Detected

**Chain ID:** 33111
**Chain Name:** Curtis
**Conflict Type:** relation_source_conflict
**Message:** Chain 33111 (Curtis) has testnetOf relation in theGraph but isTestnet=false in chainlist

### The Graph Relation
- **Kind:** testnetOf
- **Network:** apechain
- **Chain ID:** 33139
- **Source:** theGraph

### Chainlist Data
- **isTestnet:** false

---
This issue was automatically created by the data validation system.
Rule: Rule 1 - Relation Conflicts
```

---

## Issue 3: Chain 80069 (Berachain Bepolia)

**Title:** `[Data Validation] Relation conflict for chain 80069 (Berachain Bepolia)`

**Labels:** `data-validation`, `relation-conflict`, `automated`

**Body:**
```markdown
## Relation Conflict Detected

**Chain ID:** 80069
**Chain Name:** Berachain Bepolia
**Conflict Type:** relation_source_conflict
**Message:** Chain 80069 (Berachain Bepolia) has testnetOf relation in theGraph but isTestnet=false in chainlist

### The Graph Relation
- **Kind:** testnetOf
- **Network:** berachain
- **Chain ID:** 80094
- **Source:** theGraph

### Chainlist Data
- **isTestnet:** false

---
This issue was automatically created by the data validation system.
Rule: Rule 1 - Relation Conflicts
```

---

## How to Create These Issues

### Option 1: Using GitHub Web UI
1. Go to https://github.com/Johnaverse/chains-api/issues/new
2. Copy the title and body from above for each issue
3. Add the labels: `data-validation`, `relation-conflict`, `automated`
4. Click "Submit new issue"
5. Repeat for all 3 issues

### Option 2: Using GitHub CLI (gh)
```bash
# Issue 1
gh issue create \
  --repo Johnaverse/chains-api \
  --title "[Data Validation] Relation conflict for chain 1287 (Moonbase Alpha)" \
  --body "..." \
  --label "data-validation,relation-conflict,automated"

# Issue 2
gh issue create \
  --repo Johnaverse/chains-api \
  --title "[Data Validation] Relation conflict for chain 33111 (Curtis)" \
  --body "..." \
  --label "data-validation,relation-conflict,automated"

# Issue 3
gh issue create \
  --repo Johnaverse/chains-api \
  --title "[Data Validation] Relation conflict for chain 80069 (Berachain Bepolia)" \
  --body "..." \
  --label "data-validation,relation-conflict,automated"
```

### Option 3: Using GitHub API with curl
Requires a Personal Access Token with `repo` scope.

---

## Summary

All 3 relation conflicts have been identified and documented above. These represent data inconsistencies where The Graph indicates a chain is a testnet (via `testnetOf` relation) but chainlist.org marks the same chain as `isTestnet=false`.

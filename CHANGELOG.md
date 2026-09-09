# Changelog

## Unreleased

- Cut review crawl cost: exact-duplicate `file_read` calls now get a short
  reminder instead of another full dump, and 8 duplicate-only rounds with
  no new evidence stop the file early instead of running to the round cap.
- Failed review items now keep the findings they already emitted (grace-round
  notes included), run the review filter over them, and persist them on the
  failure record — what the CLI shows and what the session stores agree.
- A missing `file_read` path now points the model at `file_find` first
  instead of guessing nearby paths.
- Live per-file status lines on stderr: file start, file done with note
  count and a run-level done counter, plus a quiet warning at half the
  per-file idle timeout. Agent-audience runs stay silent.
- The per-file timeout is now idle-based: each model response resets the
  window, so a slow-but-working file is never killed; a quiet file is
  aborted and classified as a timeout. Streaming progress keeps both the
  compression job timer and the per-file watchdog alive.

- Failed tool uses now show up in results with details instead of
  vanishing: output carries how many failed, which tool, and the arguments
  that were passed. Adopted surgically from OCR v1.11.4 (`0524d21`) and
  v1.11.3 (`b3704b8`).
- Mangled review notes from the model are now repaired instead of dropping
  the whole batch, with a warning left behind. Batches that can't be
  repaired safely keep the original error so the model retries. Adopted
  surgically from OCR v1.11.4 (`41917e2`).
- Git failures now surface git's own message instead of empty results, and
  untracked-file listing errors stop the review instead of reviewing
  half-blind. Adopted surgically from OCR v1.10.0 (`0c44f10`) and v1.11.3
  (`4cecf1e`).
- Project rule files are now confined to the repository: a symlinked or
  escaping `rule.json`, or a rule file reference pointing outside the repo,
  is rejected with a warning. Adopted surgically from OCR v1.11.1
  (`124bfc3`).
- JavaScript module files (`.mjs`/`.cjs`) get JavaScript review rules and
  `.cxx`/`.hxx` files get C++ rules instead of generic ones. Adopted
  surgically from OCR v1.11.2 (`b1ad13a`, `14fab72`).
- All warnings now go through one channel: rule-loader warnings accept an
  injectable sink (default stderr), repaired batches always warn, and tool
  persistence delivery failures warn instead of vanishing.
- `--model` and the no-flag fallback now see providers registered by
  user-level pi extensions (proxies, aggregators such as kilo). Only
  user-scope extensions under the agent directory run, solely to collect
  provider registrations, in a neutral working directory and offline; a
  broken extension costs its provider only and produces a warning.
  Repository extensions are still never loaded or executed.
- `file_find` now supports subpath and cross-platform queries: queries
  containing `/` or `\\` fall back to full repository-relative path matching
  when basename matching finds nothing, and backslash separators are
  normalized. Tool schema descriptions updated to match. Adopted surgically
  from OCR commit `47192a2` (v1.11.0, PR #1075).
- The other-changed-files prompt context now includes per-file churn stats —
  `STATUS   path (+N/-M)` — so the model can gauge each sibling file's diff
  size before requesting it. Mechanism adopted from OCR commit `43ef414`
  (v1.11.0, PRs #1078/#1082).
- Relicense the project from GPL-2.0-only to GPL-3.0-or-later, add Apache-2.0
  attribution for the Open Code Review v1.9.3 source port, and pin that release
  as the behavioral compatibility target.
- Replace the diff-only, fail-open veto with mandatory evidence-backed finding verification. Only positively verified candidates with exact host-validated citations are emitted; verification failure now marks the file incomplete.

## [0.3.0](https://github.com/bermudi/pi-reviewer/compare/v0.2.0...v0.3.0) (2026-09-09)


### Features

* announce remaining tool-round budget to the model mid-loop ([3fd981d](https://github.com/bermudi/pi-reviewer/commit/3fd981df0a8eb1010731ea4db1ea9d44bec53ba7))
* **cli,verifier:** add parity --no-filter, --preview, --from/--to aliases and preview selection fixture ([dfdacb6](https://github.com/bermudi/pi-reviewer/commit/dfdacb614eec98cab6e8ffe4474339d39c80421c))
* **cli:** port emit, budget, retry report (41 tests) with packed boundary ([d0eba8f](https://github.com/bermudi/pi-reviewer/commit/d0eba8ff346f334f9ab13dccf3c686c7e92f8284))
* **cli:** port OCR background-file behavior and tests ([a4ed21e](https://github.com/bermudi/pi-reviewer/commit/a4ed21e41950060dcbf7b209d8e88f40ddb28bc2))
* **cli:** port OCR output, shared, SARIF helpers (76 tests) ([ff6219b](https://github.com/bermudi/pi-reviewer/commit/ff6219b7d4e3be0b3a3fd39ac1f2fe88a097a498))
* **cli:** port OCR tools configuration and tests ([932340a](https://github.com/bermudi/pi-reviewer/commit/932340ac854c5111e48f137d7f6465da59f64fe2))
* **cli:** port review/scan flags, helpers, resume (39 tests); cli-output pending 0 ([8334cae](https://github.com/bermudi/pi-reviewer/commit/8334caee519397422e7e3f009390c0dd5b6bb148))
* **cli:** port session commands and display (23 tests) ([4688432](https://github.com/bermudi/pi-reviewer/commit/468843247d1fa7b9183357145137144aac861957))
* file_find subpath queries and churn stats in other-changed-files ([a7fe762](https://github.com/bermudi/pi-reviewer/commit/a7fe762f513f8b2f7fb8b567e21f398bfa3aa257))
* implement Phase 5 verifier for scan/session/output and cutover ([8af4c70](https://github.com/bermudi/pi-reviewer/commit/8af4c7094fffb29862a0de55ca6a652b9d9918b5))
* **inventory:** explicit equivalent/not_applicable/validated scoped dispositions ([a4d93e7](https://github.com/bermudi/pi-reviewer/commit/a4d93e778f6f0c9403308fd24c2241938204255b))
* **llmloop:** wire session identity through RequestMeta for parity ([d3baa57](https://github.com/bermudi/pi-reviewer/commit/d3baa57a57cca527c91c83fa8191d4498d1cc558))
* **ocr-v193:** checkpoint Phase 1 and scaffold parity engine ([9535de6](https://github.com/bermudi/pi-reviewer/commit/9535de65176c62fa8b10493dd4f1bbb9c6e276b4))
* **ocr-v193:** implement relocation, review filter, compression; expand harness ([9c588b1](https://github.com/bermudi/pi-reviewer/commit/9c588b12a3c2b150d534e3a929a975878a131b85))
* **ocr-v193:** Phase 0 evidence plumbing + verifiers (trace, comparer, verify:phase0-1-2-3-4-5-cutover) ([037d3c4](https://github.com/bermudi/pi-reviewer/commit/037d3c4eea3bbb419518219579ded659a1a8a28a))
* **ocr-v193:** port llmloop core (loop + compression + pool) with Pi adapter seam ([b4442c6](https://github.com/bermudi/pi-reviewer/commit/b4442c616d77ebc5605db3a7660d181b6586de3d))
* **ocr-v193:** port parity engine vertical slice (Phases 2-9) ([df2122a](https://github.com/bermudi/pi-reviewer/commit/df2122a549263d6ae655b958f3183b51ae6f9937))
* **phase3:** expand lifecycle tests + PiTransport verifier (resolver, relocation, collector, loop, filter, async drain, production collector, fenced/malformed, error/abort, partial survival, negative mismatch) ([8dddf3c](https://github.com/bermudi/pi-reviewer/commit/8dddf3cb837b84a7efc0fae0fb7e7ab1c0644322))
* phase4 verifier covering inputs, selection, budgets ([f1da36f](https://github.com/bermudi/pi-reviewer/commit/f1da36f04ad99171054977aae9c3dc09413d8e77))
* pi-review findings replays a recorded session without a model ([04d40af](https://github.com/bermudi/pi-reviewer/commit/04d40aff0ca5154dd16708a9c79aa6cfe9e449a7))
* port OCR color output modes ([c1f86c7](https://github.com/bermudi/pi-reviewer/commit/c1f86c73cfad369ee8fac0b7478e66b3a1d66819))
* port OCR v1.9.9 review filter ([30af348](https://github.com/bermudi/pi-reviewer/commit/30af3481066015e3f18f70a017ad934d03da016a))
* port OCR v1.9.9 rules and relocation ([62da0cf](https://github.com/bermudi/pi-reviewer/commit/62da0cfcb70aa10abd71e97feeccf119c858e205))
* report tool call failures with args in output ([e55f500](https://github.com/bermudi/pi-reviewer/commit/e55f5006eb420334d83f83c7139201b094c46ad9))
* review test sources and pin system prompts via golden snapshots ([6467e55](https://github.com/bermudi/pi-reviewer/commit/6467e554e30604f23d2f72e2e2e1c595f967767e))
* **review:** live per-file status lines on stderr ([2c93f4c](https://github.com/bermudi/pi-reviewer/commit/2c93f4c905c46d3ec8c924bc0b365c1582478541))
* **review:** per-file timeout is now idle-based ([f79b919](https://github.com/bermudi/pi-reviewer/commit/f79b919b25ea8b3ecb6a87f92f6b0e4cd6221a85))
* **review:** streaming progress keeps idle timers alive during long requests ([8c4f86d](https://github.com/bermudi/pi-reviewer/commit/8c4f86d0e466f7c1b23d8157c68b7e2829d97458))
* **verify:** Gate 0 black-box harness and integrity verifier ([78e72af](https://github.com/bermudi/pi-reviewer/commit/78e72af14e99d83a13bb580a1b00a46c8a29a971))
* **verify:** Gate 0 verified ledger + Gate 1 sdk-feasibility harness (blackbox via packed package) ([b2be2ac](https://github.com/bermudi/pi-reviewer/commit/b2be2ac8e5548f00d90ba62862e21b0cf0fbcc5a))
* **verify:** Gate 2 vertical slice — pinned OCR without preview, packed Pi CLI, separate repos/servers, output parsing, comment mutation ([577cb09](https://github.com/bermudi/pi-reviewer/commit/577cb09ba62622ee2efbe0a1c01748c46c74e013))
* **verify:** Phase 1 full PiTransport harness with 7 scenarios (trace, grace, empty, compression, isolation, stall) ([80b495c](https://github.com/bermudi/pi-reviewer/commit/80b495cd4ff20bee2950b09b1b07f0fb4056253c))
* **verify:** Phase 2 vertical slice via PiTransport + OCR differential (wire trace) ([e9ddee2](https://github.com/bermudi/pi-reviewer/commit/e9ddee2a7a91389d9d95267ce90f2dd3252efd5b))


### Bug Fixes

* accept OCR-style unknown flag in cutover gate ([3affaab](https://github.com/bermudi/pi-reviewer/commit/3affaab7fa08ee482efaf2b833b1fcd1a82d7e15))
* activate OCR filter tools through Pi ([b186c69](https://github.com/bermudi/pi-reviewer/commit/b186c696359030d183df9cf598ee320054ef8407))
* address review of 7f6d94ad — remove test-only helpers, restore colon flag, pure version\n\n- Delete src/ocr-v193/cli/arg-helpers.ts and test/ocr-v193/cli/arg-helpers.test.ts; all six cmd/opencodereview/arg_errors cases now not_applicable with Cobra-family reasons (positional validators unused by reduced review/scan/version CLI)\n- Delete test/ocr-v193/cli/stdout.test.ts and test/ocr-v193/cli/manual-retry.test.ts; map internal/stdout TestWriter_Default/TestQuiet and manual_e2e TestManualE2ERetryReport to existing injected boundary tests in test/cli.test.ts via equivalent annotations (stdout writer default, quiet via QuietHandle, manual clean/recovered/failed via RetryCollector)\n- Remove mutable VERSION/GIT_COMMIT/BUILD_DATE and __setVersionForTest plus unused printVersion; keep OS/arch in versionString via new pure formatVersion(BuildInfo) and update smallfiles tests to call formatVersion directly\n- Keep flag suggestion, restore OCR exact 'unknown flag: --name' colon form in parseFlags, and add runCli wiring test in flag-suggest.test.ts proving typo --forma suggests --format\n- Regenerate inventory covered 986 equivalent 110 not_applicable 201 pending 129; tsc, bun test 1371 pass, build ok ([6a7da02](https://github.com/bermudi/pi-reviewer/commit/6a7da02ac964c1cd5bf2d6076b191911e26741a0))
* **agent:** dispatch applyResume, reuse, token threshold; test dispatch (7) ([0050929](https://github.com/bermudi/pi-reviewer/commit/005092938d451f8be8964c1b48381cc0807dd1c8))
* **agent:** formatToolDefs raw order vs sorted fallback ([8bd33b7](https://github.com/bermudi/pi-reviewer/commit/8bd33b7fca41629be4aec03053ace799b2059dc9))
* **agent:** formatToolDefs raw order, BuildToolDefs, filter helpers; test helpers (12) ([ffd4248](https://github.com/bermudi/pi-reviewer/commit/ffd4248713dfc51c47c7f98e8a617ef9aba3a110))
* **agent:** hash framing, manifestItemID, rule/source/runtime digests; test manifest_hash (6) ([b2431ed](https://github.com/bermudi/pi-reviewer/commit/b2431ed63ea73505d2693c4d729262e7b6a3265b))
* **agent:** identity, sealed input, request meta; test identity/sealed/retry (8) ([34f8e25](https://github.com/bermudi/pi-reviewer/commit/34f8e25b008f1c297f657042245b633ab96d303e))
* **agent:** manifest input, execution, reuse, panic; test manifest-integration (11) ([a6518e1](https://github.com/bermudi/pi-reviewer/commit/a6518e131f74a324b248aea1742f4e6e3862053d))
* **agent:** preserve raw tool parameter order for plan phase (OCR parity) ([d8d7b87](https://github.com/bermudi/pi-reviewer/commit/d8d7b873c8e537101e66d2ab3ec08c39f87409a6))
* **agent:** remove test-shaped aliases and wrappers, narrow to canonical shapes, move pure helpers ([57a07f8](https://github.com/bermudi/pi-reviewer/commit/57a07f8b4b030d3b4e685874beb7568ed187e628))
* **agent:** use real canonical template for identity (remove synthetic t/c stub) ([67f31e1](https://github.com/bermudi/pi-reviewer/commit/67f31e1457855f598232f101de0e9ed1a8bdabca))
* avoid engine substring in cli adapter comment ([8414038](https://github.com/bermudi/pi-reviewer/commit/84140388c38e6a31fadd7298218450bac3c73beb))
* **build:** copy template/rules data files into dist for packed install ([7b4508b](https://github.com/bermudi/pi-reviewer/commit/7b4508b036ae6327d43176355aedc629455e80f0))
* **cli,transport:** delegate --engine ocr-v193 to parity CLI factory with production tools, map OCR system prompt to Pi systemPrompt ([dc58e9d](https://github.com/bermudi/pi-reviewer/commit/dc58e9df0e3f02c08b0449fd8f29abc1d3de57b7))
* **cli:** accept 'review' as optional subcommand alias ([e2eb610](https://github.com/bermudi/pi-reviewer/commit/e2eb610037b425827e274856b836bb24677d92f1))
* **cli:** add --version/-V flag ([091a7a8](https://github.com/bermudi/pi-reviewer/commit/091a7a811865cb7c8d5399b5212b9ebcf35c6661))
* **cli:** enforce exact model tool allowlist ([19541be](https://github.com/bermudi/pi-reviewer/commit/19541bed4e749a3bcbf7379025cac24dc42ba3e3))
* **cli:** force process exit to prevent Pi SDK keep-alive hangs in multi-file scan ([7e365a8](https://github.com/bermudi/pi-reviewer/commit/7e365a88d9ecb92400348d1838ca55228fd766b4))
* **cli:** implement --engine ocr-v193 inline Runner+PiTransport for Gate2 vertical ([f2e0d02](https://github.com/bermudi/pi-reviewer/commit/f2e0d02dee76ef79cbffadc7a9411aebe4c05742))
* **cli:** keep Git validation at input boundary ([c3aca13](https://github.com/bermudi/pi-reviewer/commit/c3aca13cb5c457e4582824888b86f32139ba3cab))
* **cli:** preserve background reader boundary and branding ([d359b03](https://github.com/bermudi/pi-reviewer/commit/d359b034e441abafb6c2414731b891fec66c11b9))
* **cli:** remove model from Pi transport creation for Gate2 ([af1f827](https://github.com/bermudi/pi-reviewer/commit/af1f82795cf3e6f0389d1a64523db8b52689f991))
* **cli:** use repoDir as cwd for parity transport ([6076e31](https://github.com/bermudi/pi-reviewer/commit/6076e31c86fc1e7d8fb57a8544138a2eaa3b5856))
* **cli:** wire Git validation into review path ([1e54f8d](https://github.com/bermudi/pi-reviewer/commit/1e54f8de51e28211c05e2a82a6c1794f25fd226a))
* complete Pi model and resume wiring ([a6d616c](https://github.com/bermudi/pi-reviewer/commit/a6d616ce0ac2466f7dced68bab8dae01f341b86b))
* confine project rule.json to repo root (security) ([441db6a](https://github.com/bermudi/pi-reviewer/commit/441db6a7ac7cf80adbeaacee3d3f0a677f595158))
* correct --model splice index in core-review verifier ([5193dc2](https://github.com/bermudi/pi-reviewer/commit/5193dc244b789aa865732332198f5d4589b2090f))
* correct final inventory audit — truthful scope and stale docs\n\n- testconnection: keep TestLoadDefault notApplicable, map TestResolveLang/TestApplyLanguage/TestApplyLanguage_EmptyLang as equivalent to template.test.ts (resolves empty and explicit languages, appends language to review system messages, defaults an empty language to English)\n- Rewrite 129 provider/config notApplicable to truthful omitted-boundary phrasing (pi-reviewer has no config/provider/MCP/telemetry commands and does not mutate ~/.pi/agent; users configure via external pi tooling, runtime only reads via SettingsManager/DefaultResourceLoader) and reformat to readable multi-line Map style; distinguish timeout/max-token/language runtime vs omitted persistence\n- README/AGENTS: correct 324-&gt;321 notApplicable, clarify ~/.pi/agent is Pi external auth/model location, inventory 0 pending with 321 notApplicable 475 outOfScope so full parity not claimed\n- docs/ocr-v1.9.3-port-plan.md: add inventory-completion scope-boundary paragraph, fix 324-&gt;321\n- docs/ocr-v193-reference-manifest.md: Gate 5 already correct at fe7b8bb 8/32 pack 4c41b80, remove stale legacy-retained claim, fix double bar on Gate 3\n- Strengthen TestManualE2ERetryReport to 3 evidences (clean, recovered+failed, all-fail) via retry-e2e.test.ts, keep stdout equivalents\n- Verifiers: tsc pass, 1368 tests pass, build ok, inventory 0 pending ([bb253c0](https://github.com/bermudi/pi-reviewer/commit/bb253c05faa057b60d6e80bb252e5d4855e75747))
* enforce OCR filter tools fail closed ([daf9d2e](https://github.com/bermudi/pi-reviewer/commit/daf9d2e1b9cc20c1185478da2555af6f37afab74))
* enforce persistent color flag semantics ([9480edc](https://github.com/bermudi/pi-reviewer/commit/9480edc2fe4a13775ecd2298dd7207f518e2fc21))
* **factory:** inject system rules and apply language directive ([06b9199](https://github.com/bermudi/pi-reviewer/commit/06b9199645fd739f479d137159dba0054fd69126))
* **factory:** strip empty plan block before substituting placeholder ([01b7741](https://github.com/bermudi/pi-reviewer/commit/01b7741b27a2f3fdd51721b0c878d05185b6fcfa))
* guarantee runtime cleanup on every path ([260aeee](https://github.com/bermudi/pi-reviewer/commit/260aeee01397d289df75a8c61a82c1b6242336ac))
* harden Pi runtime and review resume ([ae3d571](https://github.com/bermudi/pi-reviewer/commit/ae3d571f3be6f93a86c91dffab0e9e01f5bb5005))
* honor Pi thinking-level model selectors ([5aff447](https://github.com/bermudi/pi-reviewer/commit/5aff44732a61801b510952f61411d7a3688fa63b))
* include scan session in text summary ([678b4af](https://github.com/bermudi/pi-reviewer/commit/678b4af7cd7cf48464f2ec33c2bcdba2730333c3))
* isolate concurrent Pi review sessions ([3443a22](https://github.com/bermudi/pi-reviewer/commit/3443a22af5f5195aaef97f117eeb79d3481a9e44))
* **loop:** count genuinely empty provider responses toward empty-round limit ([f7cf357](https://github.com/bermudi/pi-reviewer/commit/f7cf3574fe9edb0ac7b72f0a3a23145a25663c62))
* make warnings consistent across repair, loaders, and persist path ([9709e80](https://github.com/bermudi/pi-reviewer/commit/9709e809c77823c86925e3be973963127179a908))
* name OCR main-loop stop reasons ([a513b77](https://github.com/bermudi/pi-reviewer/commit/a513b770b45565fd12dc5becf8a44972dbdc23e6))
* own Pi runtime resources per run ([d4ef7f8](https://github.com/bermudi/pi-reviewer/commit/d4ef7f83f1ec9a6a1c0847bd53e76cf11c0ca1d0))
* **path:** extract pathutil, unify WithinBase/CanonicalPath, cover path traversal symlink safety ([ef39e90](https://github.com/bermudi/pi-reviewer/commit/ef39e90826194fd48d57f1e3657d194e80826c02))
* persist cancelled review checkpoints ([e656a38](https://github.com/bermudi/pi-reviewer/commit/e656a3812dab25d604c32227b9a4a5c41303a5eb))
* **phase3:** manualDiff for relocation fixtures (hunk contains added lines, deterministic) ([fb2ac6c](https://github.com/bermudi/pi-reviewer/commit/fb2ac6cfe7abbb63100b9297b3abb22c559c5221))
* **phase3:** partial fixture uses file_read empty result to trigger StopEmptyRounds ([1345a2a](https://github.com/bermudi/pi-reviewer/commit/1345a2a1d96a1a9257ef5cef9e19cd3bcb3cca01))
* **phase3:** resolver differential via custom Runner with diffLookup (not runPiRealHarness) + pi trace ([0f8bed4](https://github.com/bermudi/pi-reviewer/commit/0f8bed47540bec14a98a1c66697e994a47f8b97e))
* **pi-adapter:** build-params and resolver dispatch batch ([6b884c9](https://github.com/bermudi/pi-reviewer/commit/6b884c959a99694b26d36b4c9a61394ba585d026))
* **pi-adapter:** client session-key and streaming provider-specific batch ([10d483c](https://github.com/bermudi/pi-reviewer/commit/10d483c3e4195d4d1334d6ef335b2f55d3c45540))
* **pi-adapter:** client/responses tail extra-body/status/session-key/truncation seam ([5c14043](https://github.com/bermudi/pi-reviewer/commit/5c1404317a20bf81dd73abf2f9ec33de60d9f5d2))
* **pi-adapter:** message helpers and usage/cache batch ([031c7ad](https://github.com/bermudi/pi-reviewer/commit/031c7ad2e13afd5206fdedc266e0030ce09f26f2))
* **pi-adapter:** message remaining batch ([86c39c4](https://github.com/bermudi/pi-reviewer/commit/86c39c468d17336b471979cab3ac473d587b8fd4))
* **pi-adapter:** protocol, think-tag, tool-schema message batch ([a7f7750](https://github.com/bermudi/pi-reviewer/commit/a7f7750c0f3c0266274eebb63da7fb69aa9c3c15))
* **pi-adapter:** resolver dispatch not_applicable batch ([00dac88](https://github.com/bermudi/pi-reviewer/commit/00dac884ab4100b272d48e9312f73ff5f81a551a))
* **pi-adapter:** resolver seam ParseExtraHeaders/ParseRetryCodes/timeout/model-suffix and merging ([235120b](https://github.com/bermudi/pi-reviewer/commit/235120ba79fea9e2b91fd22e0475a467a8f22f70))
* **pi-adapter:** responses provider-specific not_applicable batch ([2e795e6](https://github.com/bermudi/pi-reviewer/commit/2e795e68072e59cb9aedf51c775ff8758949f5d9))
* **pi-adapter:** retry middleware batch ([6c87ca5](https://github.com/bermudi/pi-reviewer/commit/6c87ca5197f7bc7157034bf7354e9457bb7bebfd))
* **pi-adapter:** session-key helpers batch ([9aa78f3](https://github.com/bermudi/pi-reviewer/commit/9aa78f342d7ab135a6f7d53bc5365b4e9a8fe849))
* **pi-adapter:** wire session affinity via public SessionManager id seam ([02f5a45](https://github.com/bermudi/pi-reviewer/commit/02f5a45f36f5cdb57ef0429c35212df78326e733))
* **pi-adapter:** wire typed RetryCollector at PiTransport seam and freeze at run boundary ([1b193c1](https://github.com/bermudi/pi-reviewer/commit/1b193c1750f2aea39ba02af096f4408f136e1f95))
* **pi-real:** correctly map trace toolCalls args (already parsed object vs string) ([e1abded](https://github.com/bermudi/pi-reviewer/commit/e1abdedca4ee4e210044d74a8af1e47cc2905424))
* pin allowModelNetwork: false in selector runtime creation ([14cbfb7](https://github.com/bermudi/pi-reviewer/commit/14cbfb7258d24d95251a889e3cb5b4128d492014))
* port OCR v1.9.9 background precedence ([c44c42a](https://github.com/bermudi/pi-reviewer/commit/c44c42ad4663f25d46181ea3557f42c3ddaa949f))
* preserve human progress on stderr ([432855a](https://github.com/bermudi/pi-reviewer/commit/432855a7a7f43d9f1c67b967a487e89e10e8c550))
* preserve per-test inventory consistency ([206b590](https://github.com/bermudi/pi-reviewer/commit/206b590cdee8a8a0f5f1e48413a43b6e001839dc))
* preserve scan stage session affinity ([db03ea6](https://github.com/bermudi/pi-reviewer/commit/db03ea664e8d8515c4ad49ee45a7e8e42412316b))
* publish manifest on session delivery failure ([10f263c](https://github.com/bermudi/pi-reviewer/commit/10f263cac483f0018d1f5b7c7a1c4b5737c07b84))
* remove legacy word from cli adapter comment ([944957f](https://github.com/bermudi/pi-reviewer/commit/944957fb30e5f1664f391405e6cfae5e229f257c))
* repair serialized code_comment args instead of losing batch ([7f0b0c0](https://github.com/bermudi/pi-reviewer/commit/7f0b0c0334da673e0456241d0a9725d4c0171a4d))
* repin release gates to OCR v1.9.9 ([be1c87f](https://github.com/bermudi/pi-reviewer/commit/be1c87fb4981f106277af3b354f9a81efadfe337))
* replace OCR branding with pi-reviewer in parity CLI help text ([b0c3a7c](https://github.com/bermudi/pi-reviewer/commit/b0c3a7ccbba67b40e18e8f93c34e45b5b8d9d5a0))
* replace Pi history through public agent state ([5e0fe41](https://github.com/bermudi/pi-reviewer/commit/5e0fe41f53068877049d23f8d9e8a0fcdbdc9a39))
* require versioned OCR upgrade evidence ([1036d13](https://github.com/bermudi/pi-reviewer/commit/1036d13414ca2616e87d7b9477acc42f88935caf))
* resolve model selectors against Pi's current cached catalog ([6157672](https://github.com/bermudi/pi-reviewer/commit/6157672186a550e380f434b21039dbf6a68f7609))
* **retry:** output-schema serializer and scan divergence ([906a11f](https://github.com/bermudi/pi-reviewer/commit/906a11fc9105173e28754961f13b10403628e0c6))
* **retry:** port retry_boundary error/status/truncation classification ([35e2187](https://github.com/bermudi/pi-reviewer/commit/35e2187c900e6ff74d51547c0b22f18b1f705abe))
* **retry:** port retry_meta deterministic metadata/hash contracts ([ea658df](https://github.com/bermudi/pi-reviewer/commit/ea658dfa928d014323ed7acd00d9ac7377316248))
* **retry:** port retry_observer and retry_report collector/report ([743a665](https://github.com/bermudi/pi-reviewer/commit/743a665fec65f3eefe0901115edab6cb3e9873df))
* **review:** centralize per-file timeout default across entry points ([3877d34](https://github.com/bermudi/pi-reviewer/commit/3877d347813ff191fff442dbd5ac2a9160cfde89))
* **review:** idle watchdog covers compression, grace, and re-location ([9201c4f](https://github.com/bermudi/pi-reviewer/commit/9201c4f257154efbde095dbea6b1ff302b8fa139))
* route .mjs/.cjs to JS rules and .cxx/.hxx to C++ rules ([ef06c37](https://github.com/bermudi/pi-reviewer/commit/ef06c37b6d9d63fde7f41bd94af38f61fcf6bf3d))
* route OCR progress through injected IO ([0b94983](https://github.com/bermudi/pi-reviewer/commit/0b949836378752492cd305cfb2dd818f2cfb0428))
* **rules:** keep white-box helpers out of barrel ([acd44ec](https://github.com/bermudi/pi-reviewer/commit/acd44ec7182dd812b0cb1fc8647a410671d161b6))
* **rules:** respect HOME env in global rule and expose white-box helpers ([1d42b4f](https://github.com/bermudi/pi-reviewer/commit/1d42b4ffc4ec5e3054e663163dc161543f625589))
* **scan:** do not apply language directive without config, matching OCR ([32d7770](https://github.com/bermudi/pi-reviewer/commit/32d77701187438f95ed03f7ec7171f76d7fd8a15))
* **scan:** pass mainToolDefs to Pi transport so scan can contact provider ([d2d1c15](https://github.com/bermudi/pi-reviewer/commit/d2d1c157eed1197e07c5406ac57f187aa89e98b1))
* **scan:** propagate BudgetExceeded via factory runner ([4589a16](https://github.com/bermudi/pi-reviewer/commit/4589a16c63499b6d2808b167f281a089d3a879ba))
* **scan:** remove retry report seam ([d56cf86](https://github.com/bermudi/pi-reviewer/commit/d56cf86ebf9dc3905c767de16add2a9500f86d5c))
* second review of 28-case tranche — pure version, flag helper, dedup evidence\n\n- Remove three duplicated tests from test/cli.test.ts; map TestWriter_Default to pre-existing help-to-stdout test and TestQuiet to factory injection stdout/stderr separation test via equivalent annotations in test/cli.test.ts\n- Map TestManualE2ERetryReport to existing retry-e2e.test.ts clean/recovered/failed/packed tests via single manual annotation and expanded localCoverage (retry-e2e now covers both retry_report and manual); no duplicated RetryCollector internals\n- Fix arg_errors scope to out_of_scope with omitted Cobra positional families (config/session/delegate/completion) and remove notApplicable that claimed covered helpers; all six now out_of_scope via file scope\n- Make formatVersion pure: BuildInfo now includes platform/arch, versionString supplies process.platform/arch, smallfiles tests pass explicit platform/arch\n- Make flagErrorWithSuggestion part of real parser path (parseFlags now throws flagErrorWithSuggestion with CliUsageError), preserve exact 'unknown flag: --name' colon form; both helper unit tests and runCli wiring test prove live suggestion\n- Regenerate inventory covered 987 equivalent 109 pending 129; tsc, 1368 tests pass, build ok ([24cb0a2](https://github.com/bermudi/pi-reviewer/commit/24cb0a2e972030fb185ef8f147883ae8b3cebe1b))
* **server:** capture request before delay to prove stalled request reached server ([f70de79](https://github.com/bermudi/pi-reviewer/commit/f70de79fcd9038be58f3504ff622688551d76191))
* **session:** remove Go nil-receiver emulation, use public paths ([e6d6f91](https://github.com/bermudi/pi-reviewer/commit/e6d6f9157588071cd0430c766194cd0901adee64))
* surface abort reasons instead of bare Aborted ([28d7a4b](https://github.com/bermudi/pi-reviewer/commit/28d7a4b3a705540f0cef3528fb444c114036cfed))
* surface git stderr and propagate untracked listing errors ([799bf26](https://github.com/bermudi/pi-reviewer/commit/799bf269b1f3e1e9bac21a769cc6c0ec71670dad))
* surface session writer failures ([b00ec9b](https://github.com/bermudi/pi-reviewer/commit/b00ec9b7dece6e0d93486c1c4ae61dd4dd6b7267))
* **tool:** handle DiffMap null, respect gitignore in file_find walk, cover read-diff and find ([e749775](https://github.com/bermudi/pi-reviewer/commit/e7497753bded5d6f4a2e74598380487b488de66e))
* **tool:** unify Runner signatures, cover FileReader/FileRead bounded reads and path containment ([0f220e9](https://github.com/bermudi/pi-reviewer/commit/0f220e90446ebcbc1d2948eccf3ba0167e88be5c))
* **trace:** handle undefined tool schema in recordRequest (Pi real harness uses tools without parameters) ([ca3fff6](https://github.com/bermudi/pi-reviewer/commit/ca3fff6e1d36760e3325d720fee8f1b7f0a4fdf1))
* **transport:** serialize concurrent complete() calls for async relocation ([eb44761](https://github.com/bermudi/pi-reviewer/commit/eb447615d66e4da8c23b6553cdfa4287ae2433e9))
* **transport:** use agent.continue() for round 2+ to avoid duplicate user message ([4ef1e38](https://github.com/bermudi/pi-reviewer/commit/4ef1e389247fa0b37a60efa6c3502617f9701928))
* **transport:** use DefaultResourceLoader with dynamic systemPrompt via promptRef to avoid generic Pi injection ([9982b9f](https://github.com/bermudi/pi-reviewer/commit/9982b9f458fbbd3bd5b4787ea9fc6517fc63a2a8))
* unify cancelled review persistence ([e85e7dc](https://github.com/bermudi/pi-reviewer/commit/e85e7dc45841760d87be8665d33d9ceb309541e4))
* use --format json for OCR review in retry e2e boundary test ([fdb17e0](https://github.com/bermudi/pi-reviewer/commit/fdb17e0e0c9b965fab70c5c3583c8f4493b7b92a))
* use --model instead of -m for OCR review flags ([742ed3c](https://github.com/bermudi/pi-reviewer/commit/742ed3c12e64d88d15507a2682d63521e301824e))
* use OCR --format json and --max-tools in verifiers ([3e1b416](https://github.com/bermudi/pi-reviewer/commit/3e1b416778d114c3d695afc6d95cd0e2d1f16fe7))
* use pi-reviewer identity in version string, not OCR's ([769002e](https://github.com/bermudi/pi-reviewer/commit/769002e0557928334069e4b3909927599a128485))
* **verifier:** append --model at end to avoid splitting --concurrency 1 ([0e4f62b](https://github.com/bermudi/pi-reviewer/commit/0e4f62b57d81ef8f66484e93e1e151178eba987d))
* **verifier:** ensure preview fixture repo creates docs subdir and writes binary as buffer ([1745079](https://github.com/bermudi/pi-reviewer/commit/1745079986ebba64d1adfae08ba5ed135b989fe5))
* **verify-cutover:** write library-default script to consumer dir ([d4203ea](https://github.com/bermudi/pi-reviewer/commit/d4203eaeee4fe03425a901aad3672cfab603173c))
* **verify-sessions:** use per-file batches and wait for checkpoint before kill ([20f0c45](https://github.com/bermudi/pi-reviewer/commit/20f0c459638d7b61b52f39e08eb7fa9bfe8f4c4f))
* **verify,factory:** replace timestamp placeholder, normalize Pi env injections ([9014b5c](https://github.com/bermudi/pi-reviewer/commit/9014b5c7e05c5c317781e9c263131e09415a097b))
* **verify,loop:** revert provider-empty to OCR tool-result empty, separate arrival/delivery, per-session usage equality, real concurrent adversarial, remove any ([3df8f01](https://github.com/bermudi/pi-reviewer/commit/3df8f010f9356fa4e5f85b92cfcbf2a7dffea08a))
* **verify:** abort scenario immediate abort before grace (prevent grace request) ([d18b04d](https://github.com/bermudi/pi-reviewer/commit/d18b04d88e833ce61c5c3878b9fb04130fc80cf9))
* **verify:** anti-4/5 via real artifact deletion + subprocess, offline pack, mandatory empty capture ([02b692b](https://github.com/bermudi/pi-reviewer/commit/02b692be109934457457cbe62a4993fcc21d4801))
* **verify:** compression scenario use tiny template + large tool result to ensure rebuilt succeeds (strict hasRebuilt) ([8c5c298](https://github.com/bermudi/pi-reviewer/commit/8c5c298258e4b1935ef69480b7ee4404fcc505c8))
* **verify:** deep-compare tool schemas and messages in Gate 2 vertical ([3eea55b](https://github.com/bermudi/pi-reviewer/commit/3eea55bcb2773f1d41f66d11c6f24dcc67dbfbe2))
* **verify:** explicit offline env for packed install ([9f7df18](https://github.com/bermudi/pi-reviewer/commit/9f7df18d08696494aad3f3e6a2dcac20f9a86508))
* **verify:** Gate 1 concurrent scenario with two servers ([d4ed9c4](https://github.com/bermudi/pi-reviewer/commit/d4ed9c422876178777cbab9d0f1899329f0ad176))
* **verify:** Gate 1 driver async spawn so server can handle requests ([35c2860](https://github.com/bermudi/pi-reviewer/commit/35c2860ab966e9ddecdf0694dbf61efe76dc9475))
* **verify:** Gate 1 driver writes result to file to avoid stdout pollution ([dd0a1c2](https://github.com/bermudi/pi-reviewer/commit/dd0a1c2983a3c38daca5575e6fe8794dca6a6345))
* **verify:** Gate 1 rewrite per audit — no patch, genuinely empty, positive compression, 500ms, stall proof, concurrent cancel+compress, captured usage, no any, adversarial ([0667663](https://github.com/bermudi/pi-reviewer/commit/0667663996505a370d9fae8eb6519839555c7b85))
* **verify:** Gate 1 use driver elapsed for timing checks ([92a8550](https://github.com/bermudi/pi-reviewer/commit/92a8550205537a30778609a6859ce29c0f13a6fb))
* **verify:** handle empty capture in stall check, enforce delivered 0 ([e9c04a6](https://github.com/bermudi/pi-reviewer/commit/e9c04a6a53a42031e4602c250a0c254b68348b81))
* **verify:** handle numeric stop codes for empty ([81145f4](https://github.com/bermudi/pi-reviewer/commit/81145f46c1cbc79339164541172fe6819e83a409))
* **verify:** increase stall abort delay to 250ms to ensure request reaches server ([50746e1](https://github.com/bermudi/pi-reviewer/commit/50746e12ff4af26ce032cd7540246b7f3869b32c))
* **verify:** normalize success/complete status for Gate2 ([c200fad](https://github.com/bermudi/pi-reviewer/commit/c200fad498649d99816926239fe7e73f6401e579))
* **verify:** normalize tool-name prefix in output fixtures ([7ba1659](https://github.com/bermudi/pi-reviewer/commit/7ba1659841edc09ac88bbbc677564b88c83fc4a4))
* **verify:** pack-install smoke owns its workspace beside bun cache ([3c5fc57](https://github.com/bermudi/pi-reviewer/commit/3c5fc57d1d58c594a2eb35fe586d12c21cc79e9b))
* **verify:** phase1 private-import precise check (align with phase0) ([5bf1c48](https://github.com/bermudi/pi-reviewer/commit/5bf1c48c46d2e4640b6e50f356ef37e631927989))
* **verify:** precise private-import check, allow comment mentions; restrict sessAny.agent write check ([76f9c4d](https://github.com/bermudi/pi-reviewer/commit/76f9c4d48d473721ac300101d7b9934b47ee757b))
* **verify:** preserve usage tokens in sanitized captures ([b150120](https://github.com/bermudi/pi-reviewer/commit/b15012050bb762deca80297827bc5b420f80ba45))
* **verify:** preserve workspace diff in clones via cp -a ([163ecb7](https://github.com/bermudi/pi-reviewer/commit/163ecb796fb8ffbaf814ec6a385d16e4179efcaf))
* **verify:** require hasEmptyResultError in sdk-4 pass, mutate only error string in adversarial ([a8f97c8](https://github.com/bermudi/pi-reviewer/commit/a8f97c827a98839d54d5bd70b100bc833e1f166b))
* **verify:** robust adversarial for compression via JSON replace, deduplicate marker ([d541530](https://github.com/bermudi/pi-reviewer/commit/d5415303c4373a5b7d7593064c9c4ac490ea6ba8))
* **verify:** scenario 4 empty-result not empty-tool-calls (match Go test: file_read returns empty 3x =&gt; StopEmptyRounds) ([946791c](https://github.com/bermudi/pi-reviewer/commit/946791cc22e23e9b30b80d0deb124e0083c7d0b8))
* **verify:** send state:DONE in scripted task_done response ([1a6e848](https://github.com/bermudi/pi-reviewer/commit/1a6e848128d0ae2537d8482aeb2abef30739e3e7))
* **verify:** server handles streaming and correct baseUrl for Pi SDK ([39badf2](https://github.com/bermudi/pi-reviewer/commit/39badf2f32523ea3f461d23bee41d2550a02185f))
* **verify:** tune compression thresholds to 1000 and relax distinct check ([3e99d38](https://github.com/bermudi/pi-reviewer/commit/3e99d38b06d5bee4288b4755939c44b819faf5cf))

## [0.2.0](https://github.com/bermudi/pi-reviewer/compare/v0.1.0...v0.2.0) (2026-08-13)


### Features

* resume interrupted review sessions ([016ee97](https://github.com/bermudi/pi-reviewer/commit/016ee979eb09ce2259f39137e6efd1eca1fc7ac7))
* verify findings against cited evidence ([16cf39f](https://github.com/bermudi/pi-reviewer/commit/16cf39f3a4c083a88901c2134c6001d2830c1f3b))

## 0.1.0 — 2026-08-12

- Reserve recovery capacity in the per-file tool budget so 30 normal evidence calls can still reach `submit_review`.
- Separate pre-dispatch exclusions from selected-file review coverage and keep cancellation in `skipped`.
- Bound risk plans to four prioritized risks with one evidence suggestion each.

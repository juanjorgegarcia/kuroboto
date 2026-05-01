# Changelog

## [0.3.1](https://github.com/juanjorgegarcia/kuroboto/compare/v0.3.0...v0.3.1) (2026-05-01)


### Bug Fixes

* **daemon:** permission timeout returns ask, not deny ([#34](https://github.com/juanjorgegarcia/kuroboto/issues/34)) ([da5322d](https://github.com/juanjorgegarcia/kuroboto/commit/da5322d1e2e88e29bf4128db5108fd13749a3622))

## [0.3.0](https://github.com/juanjorgegarcia/kuroboto/compare/v0.2.0...v0.3.0) (2026-04-30)


### Features

* **status:** daemon health UI — enrich kuroboto status (Spec H) ([#32](https://github.com/juanjorgegarcia/kuroboto/issues/32)) ([6afa1bb](https://github.com/juanjorgegarcia/kuroboto/commit/6afa1bb04c348f86f07d50716b420f81774adb0e))


### Bug Fixes

* address PR [#29](https://github.com/juanjorgegarcia/kuroboto/issues/29) review findings + sleep model default + CI mention workflow ([#30](https://github.com/juanjorgegarcia/kuroboto/issues/30)) ([ee34f36](https://github.com/juanjorgegarcia/kuroboto/commit/ee34f36fdfb72852aa489eb3b2fb5864d6c39439))
* **cli:** sleeping cleanup detects merged sleeps (drop bogus --head filter) ([#28](https://github.com/juanjorgegarcia/kuroboto/issues/28)) ([eb2383e](https://github.com/juanjorgegarcia/kuroboto/commit/eb2383efec1af0b7ec682f2bb0888adf500412eb))
* **cli:** surface daemon startup errors from `start --detach` ([#23](https://github.com/juanjorgegarcia/kuroboto/issues/23)) ([ae00c51](https://github.com/juanjorgegarcia/kuroboto/commit/ae00c5114c4538fc893216796fffb05ca1ee0993))
* **daemon:** drop per-tool FYI in gaming mode (crashes Telegram) ([218fae3](https://github.com/juanjorgegarcia/kuroboto/commit/218fae327b86c7eda7c6c6c58317fd8cdb5480ac))
* **daemon:** fall back to pty when tmux strategy is configured but unavailable ([#24](https://github.com/juanjorgegarcia/kuroboto/issues/24)) ([772f236](https://github.com/juanjorgegarcia/kuroboto/commit/772f23627e7e4dff1d852c7908016e351484c302))
* **daemon:** persist crash details on unhandled exception/rejection ([#26](https://github.com/juanjorgegarcia/kuroboto/issues/26)) ([84950d7](https://github.com/juanjorgegarcia/kuroboto/commit/84950d70f979428e7e9ed584e69ea475c365cf6a))
* **windows:** resolve claude.cmd in daemon claudeSpawn for npm installs ([#31](https://github.com/juanjorgegarcia/kuroboto/issues/31)) ([8e4a593](https://github.com/juanjorgegarcia/kuroboto/commit/8e4a59349a3dc6eed0cf2e1ea6fcaa86ecebb731))


### Documentation

* **specs:** cleanup --head prefix bug fix ([#27](https://github.com/juanjorgegarcia/kuroboto/issues/27)) ([2c6730c](https://github.com/juanjorgegarcia/kuroboto/commit/2c6730cab0a25ed522b09db059864384e620852f))
* **specs:** cross-model PR review delta study (Spec R) ([39db423](https://github.com/juanjorgegarcia/kuroboto/commit/39db4233c69761dbd8f171a5d537032b99ede9c6))

## [0.2.0](https://github.com/juanjorgegarcia/kuroboto/compare/v0.1.0...v0.2.0) (2026-04-29)


### Features

* **channel:** Telegram supergroup + topics (Spec F) ([#14](https://github.com/juanjorgegarcia/kuroboto/issues/14)) ([8c526f4](https://github.com/juanjorgegarcia/kuroboto/commit/8c526f461973b2426aaa1f1f9aabc073e35d658a))
* **cli:** improvements bundle (Spec I) ([#21](https://github.com/juanjorgegarcia/kuroboto/issues/21)) ([74ad4ae](https://github.com/juanjorgegarcia/kuroboto/commit/74ad4ae85221593d0358f92721b019cd78732b83))
* **cli:** kuroboto ohayo — morning ritual ([b6ec058](https://github.com/juanjorgegarcia/kuroboto/commit/b6ec058857d860fcd639796385c9285396346936))
* **config:** raise sleep defaults — maxConcurrent 6, sleepMax 8h ([#17](https://github.com/juanjorgegarcia/kuroboto/issues/17)) ([97fdecf](https://github.com/juanjorgegarcia/kuroboto/commit/97fdecf876a482e995e08adda0df5a8668967c6d))
* daemon-side allowlist match (Allow & remember takes effect immediately) ([#8](https://github.com/juanjorgegarcia/kuroboto/issues/8)) ([eeeb5a5](https://github.com/juanjorgegarcia/kuroboto/commit/eeeb5a5dfe2e60f2c928e89b022a9a82933edd56))
* **daemon:** bot prompt context header (session + intent) ([#9](https://github.com/juanjorgegarcia/kuroboto/issues/9)) ([8def4b6](https://github.com/juanjorgegarcia/kuroboto/commit/8def4b64cdd576e3114f67f892ee4700ee9673eb))
* **daemon:** desktop notifications on sleep finish ([#11](https://github.com/juanjorgegarcia/kuroboto/issues/11)) ([b867182](https://github.com/juanjorgegarcia/kuroboto/commit/b867182d0cde1a31774c55c09b0f9653e84626b3))
* **daemon:** free-text Q&A via tmux inject ([#10](https://github.com/juanjorgegarcia/kuroboto/issues/10)) ([bff9771](https://github.com/juanjorgegarcia/kuroboto/commit/bff977171ce91b0153f34a34ef8e744d2624e1e2))
* **daemon:** parallel sleep sessions (Spec D) ([#13](https://github.com/juanjorgegarcia/kuroboto/issues/13)) ([a834f69](https://github.com/juanjorgegarcia/kuroboto/commit/a834f69ba8095a10f8eadf8d5b7d744c991ca08e))
* **daemon:** PTY-based injection (replaces tmux send-keys) ([#12](https://github.com/juanjorgegarcia/kuroboto/issues/12)) ([169fd67](https://github.com/juanjorgegarcia/kuroboto/commit/169fd67c464b408bca7f0f5b9a91e4e06685f23a))
* gaming mode (timed auto-allow + always-ask list + FYI notifs) ([#2](https://github.com/juanjorgegarcia/kuroboto/issues/2)) ([3211864](https://github.com/juanjorgegarcia/kuroboto/commit/32118647ec071e1ab38bfa14135b797ef9de52de))
* kuroboto v0.1 MVP — layers 1+2 over Telegram ([d92a36a](https://github.com/juanjorgegarcia/kuroboto/commit/d92a36afdbeab629458bcd11986da82ed02ef5d5))
* permission buttons + auditable allowlist/audit log ([#1](https://github.com/juanjorgegarcia/kuroboto/issues/1)) ([620f903](https://github.com/juanjorgegarcia/kuroboto/commit/620f903b6b6250602f0aabb8c2161a90e2edeabf))
* sleep mode (autonomous Claude in worktree + auto PR) ([#3](https://github.com/juanjorgegarcia/kuroboto/issues/3)) ([5d70897](https://github.com/juanjorgegarcia/kuroboto/commit/5d708975dbc7a174d1145ec637bd6f3509cc2b39))
* sleep/gaming noise filter + progress relay (Spec J) ([#22](https://github.com/juanjorgegarcia/kuroboto/issues/22)) ([1a3cac7](https://github.com/juanjorgegarcia/kuroboto/commit/1a3cac78cb6df6efc8ed2bc3cfc69b8fd34ca9dc))
* **v0.2:** smart delay + presence mode + heartbeat hooks ([0af9343](https://github.com/juanjorgegarcia/kuroboto/commit/0af934353b214ce1d7e44121ee0b6c652eb71525))


### Bug Fixes

* **claude:** drop hard-coded .cmd extension; let PATHEXT resolve ([46e4fe3](https://github.com/juanjorgegarcia/kuroboto/commit/46e4fe3e994cc0bf099ae3a4b35fabb208d75748))
* **cli:** kuroboto claude forwards args raw, bypassing commander ([fe52786](https://github.com/juanjorgegarcia/kuroboto/commit/fe527867471cd36ce60cb11bbb51fb854175c34f))
* **daemon:** drop .cmd suffix; let Node resolve via PATHEXT ([#6](https://github.com/juanjorgegarcia/kuroboto/issues/6)) ([c8658ce](https://github.com/juanjorgegarcia/kuroboto/commit/c8658ce612206afb871d91bbaf9700ef8db39f42))
* **daemon:** hide spawn child consoles on Windows ([#18](https://github.com/juanjorgegarcia/kuroboto/issues/18)) ([0e8f62b](https://github.com/juanjorgegarcia/kuroboto/commit/0e8f62b236ec26ed12d3db17c605cc26c0618bd8))
* **daemon:** resolve .cmd suffix on Windows instead of shell:true ([#5](https://github.com/juanjorgegarcia/kuroboto/issues/5)) ([a9d876d](https://github.com/juanjorgegarcia/kuroboto/commit/a9d876d110099b6aa1ea39c4eddc9027fd5816e0))
* **daemon:** skip gaming FYI when sleep session is active ([#20](https://github.com/juanjorgegarcia/kuroboto/issues/20)) ([35520f8](https://github.com/juanjorgegarcia/kuroboto/commit/35520f8ca6776d9ee4b5905328b4917954369272))
* **ohayo:** use detached session + send-keys instead of inline shell-command ([fe16449](https://github.com/juanjorgegarcia/kuroboto/commit/fe1644911680f3127fda08079cf6cbb395acf3fb))
* sleep mode bugfixes (Windows ENOENT + slug suffix + gaming timer + base branch + cancel race) ([#4](https://github.com/juanjorgegarcia/kuroboto/issues/4)) ([4f341b2](https://github.com/juanjorgegarcia/kuroboto/commit/4f341b2501d48df3c1193a8c2a21122f2c6e9a4b))
* **v0.2:** PostToolUse must not cancel pending notifications ([93d2895](https://github.com/juanjorgegarcia/kuroboto/commit/93d2895fa48b5fd0b49b1d9f0c20837825d175c6))
* **v0.2:** Stop hook must not cancel pending notifications either ([22bb421](https://github.com/juanjorgegarcia/kuroboto/commit/22bb42124d45820ca88a9e93770d8622415b6d48))


### Documentation

* AGENTS.md as canonical agent entrypoint ([458a0df](https://github.com/juanjorgegarcia/kuroboto/commit/458a0dfa68e0141f5d5c3ea2f75b00d4a766ae62))
* align command examples with actual CLI (kuroboto sleeping start) ([2590a96](https://github.com/juanjorgegarcia/kuroboto/commit/2590a960fa5098b97eb7e23e948f32678641a720))
* comprehensive README rewrite ([#7](https://github.com/juanjorgegarcia/kuroboto/issues/7)) ([002a875](https://github.com/juanjorgegarcia/kuroboto/commit/002a87591cd6aa71c9ed9e567bed4f6cfb491ba1))
* move design spec into kuroboto repo ([3e61a2d](https://github.com/juanjorgegarcia/kuroboto/commit/3e61a2dffa3753b7ff315b451fef39b17a360e13))
* scrub spec cross-references after the move ([234b2bc](https://github.com/juanjorgegarcia/kuroboto/commit/234b2bc6bcc40851e71bbb99c47b14fc8d460861))
* **specs-backlog:** sleep state persistence across daemon restart ([e3f8e8e](https://github.com/juanjorgegarcia/kuroboto/commit/e3f8e8ec84632c8ac35cb9c2ebae4fe4daedd7a4))
* **specs:** bot UX overhaul — prompt-context + prompt-freetext-qa ([aea9641](https://github.com/juanjorgegarcia/kuroboto/commit/aea9641f5a9eed24f4abdb4a744999c2e32dd72e))
* **specs:** CI/CD stack (Spec G) — GitHub Actions + release-please ([67c8ff0](https://github.com/juanjorgegarcia/kuroboto/commit/67c8ff060ae66dcf0ac30c25165cbb96b44352e5))
* **specs:** CLI improvements bundle (Spec I) ([a09f883](https://github.com/juanjorgegarcia/kuroboto/commit/a09f8837ff00147051d07685a262ec34f7fa714a))
* **specs:** CLI layer tests (Spec H) ([40e7ca8](https://github.com/juanjorgegarcia/kuroboto/commit/40e7ca88e45284a2e84b29e5adbd890cf716877d))
* **specs:** desktop notifications + 2 backlog items ([c56ffde](https://github.com/juanjorgegarcia/kuroboto/commit/c56ffde2118c83ce7e1d70825e31d6762674876d))
* **specs:** parallel sleep sessions + morpheus run tracking backlog ([cf57f8a](https://github.com/juanjorgegarcia/kuroboto/commit/cf57f8a7ff1ebe9d9d1802987cf8aade13fe49ac))
* **specs:** pty-injection (Spec E) + defer Spec D ([7b3544e](https://github.com/juanjorgegarcia/kuroboto/commit/7b3544e086d80a409ef9a8268724f0fa1eafbede))
* **specs:** sleep noise filter + progress relay (Spec J) ([d51260c](https://github.com/juanjorgegarcia/kuroboto/commit/d51260c2d23dc0371785f760e612241b3b3e2323))
* **specs:** supergroup-topics (Spec F) + backlog reorg ([63fe58f](https://github.com/juanjorgegarcia/kuroboto/commit/63fe58fa446664630833ebff470a75417d32b92c))
* **workflow:** make /code-review mandatory after every spec implementation ([44a0b46](https://github.com/juanjorgegarcia/kuroboto/commit/44a0b462831fc08baf2b7b81bbc579f153b5ae0f))

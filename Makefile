.PHONY: help install typecheck pack publish publish-patch publish-minor publish-major clean

# Default semver bump. Override with `make publish BUMP=minor` or BUMP=major.
BUMP ?= patch

# Optional remote and branch for the publish push.
REMOTE ?= origin
BRANCH ?= main

help:
	@echo "mixcode release targets"
	@echo ""
	@echo "  make install                       Install root + workspace + tui deps"
	@echo "  make typecheck                     Run server + tui typechecks"
	@echo "  make pack                          Build a release tarball under dist/"
	@echo "  make publish [BUMP=patch|minor|major]"
	@echo "                                     Bump version, tag, push (triggers release workflow)"
	@echo "  make publish-patch | publish-minor | publish-major"
	@echo "                                     Convenience wrappers around 'make publish BUMP=...'"
	@echo "  make clean                         Remove build artifacts and node_modules"

install:
	npm install
	cd tui && bun install

typecheck:
	npm run typecheck

pack: typecheck
	mkdir -p dist
	npm pack --pack-destination dist

# Release flow:
#   1. Verify clean tree on the release branch.
#   2. Pull latest to avoid racing a teammate's push.
#   3. Bump the root package version (semver) — npm version creates a commit and tag.
#   4. Push the commit + tag; the release workflow picks up the v* tag.
publish: guard-clean guard-branch typecheck
	git pull --ff-only $(REMOTE) $(BRANCH)
	npm version $(BUMP) -m "release: v%s"
	git push $(REMOTE) $(BRANCH) --follow-tags
	@echo ""
	@echo "Pushed release tag. Watch the workflow at:"
	@echo "  https://github.com/akashsokik/mixcode/actions"

publish-patch:
	$(MAKE) publish BUMP=patch

publish-minor:
	$(MAKE) publish BUMP=minor

publish-major:
	$(MAKE) publish BUMP=major

# Internal guards — fail fast before we mutate version state.
guard-clean:
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "error: working tree is dirty. Commit or stash first."; \
		git status --short; \
		exit 1; \
	fi

guard-branch:
	@current=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$current" != "$(BRANCH)" ]; then \
		echo "error: not on $(BRANCH) (current: $$current). Checkout $(BRANCH) first."; \
		exit 1; \
	fi

clean:
	rm -rf dist node_modules server/node_modules tui/node_modules

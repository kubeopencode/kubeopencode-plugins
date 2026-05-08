# kubeopencode-plugins Makefile

PLUGIN_DIR := opencode-slack-plugin

.PHONY: install build typecheck clean publish publish-dry release

## Install dependencies
install:
	cd $(PLUGIN_DIR) && npm install

## Type-check without emitting
typecheck:
	cd $(PLUGIN_DIR) && npm run typecheck

## Build the plugin (tsup -> dist/)
build:
	cd $(PLUGIN_DIR) && npm run build

## Remove build artifacts
clean:
	rm -rf $(PLUGIN_DIR)/dist

## Dry-run publish (verify what will be published)
publish-dry: build
	cd $(PLUGIN_DIR) && npm publish --access public --dry-run

## Publish to npm under @kubeopencode scope (manual)
publish: build
	cd $(PLUGIN_DIR) && npm publish --access public

## Tag and push to trigger automated publish via GitHub Actions
## Usage: make release PLUGIN_DIR=opencode-slack-plugin
release:
	@VERSION=$$(cd $(PLUGIN_DIR) && node -p "require('./package.json').version") && \
	TAG="$(PLUGIN_DIR)/v$$VERSION" && \
	echo "Creating tag: $$TAG" && \
	git tag -a "$$TAG" -m "Release $(PLUGIN_DIR) v$$VERSION" && \
	git push origin "$$TAG"

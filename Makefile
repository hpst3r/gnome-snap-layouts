UUID   := snap-layouts@wporter.org
SCHEMA := org.gnome.shell.extensions.snap-layouts.gschema.xml
SRC    := $(UUID)
DEST   := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: test check pack install uninstall nested e2e review clean

test:
	@set -e; for t in $$(ls tests/*_test.js 2>/dev/null); do echo "== $$t"; gjs -m $$t; done

check: test
	@set -e; for f in $$(find $(SRC) -name '*.js'); do node --input-type=module --check < $$f || { echo "syntax: $$f"; exit 1; }; done
	glib-compile-schemas --strict --dry-run $(SRC)/schemas

pack: check
	mkdir -p build  # gnome-extensions pack segfaults if -o dir is missing
	cd $(SRC) && gnome-extensions pack --force --extra-source=lib --schema=schemas/$(SCHEMA) -o ../build .
	unzip -l build/$(UUID).shell-extension.zip

e2e:
	scripts/e2e.sh
	E2E_EXTRA_MONITOR=1080x1920 scripts/e2e.sh @portrait

# Review PoCs (expected to FAIL until fixed): unit + both E2E review modules.
review:
	-SNAP_REVIEW=1 $(MAKE) --no-print-directory test
	-SNAP_REVIEW=core scripts/e2e.sh
	-SNAP_REVIEW=ux scripts/e2e.sh

# Host install: symlink + compiled schema. On Wayland, log out/in, then
#   gnome-extensions enable $(UUID)
install:
	mkdir -p $(dir $(DEST))
	glib-compile-schemas $(SRC)/schemas
	ln -sfn $(CURDIR)/$(SRC) $(DEST)
	@echo "Installed -> $(DEST). Log out/in, then: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -f $(DEST)

# Visible nested shell (devkit window) for manual testing, isolated like the
# E2E harness (private dconf, buses, XDG dirs; the working tree's extension
# is copied, not installed). Needs mutter-devkit. Apps open from its dash and
# app grid (private session bus activation), or from a terminal with
#   scripts/nested.sh --run gnome-text-editor --standalone
nested:
	scripts/nested.sh

clean:
	rm -rf build .e2e $(SRC)/schemas/gschemas.compiled

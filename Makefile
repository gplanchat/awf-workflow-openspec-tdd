.PHONY: pack test clean

PACK_NAME := $(shell sed -n 's/^name: *//p' manifest.yaml)
VERSION := $(shell sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\}/\1/p' manifest.yaml)
ARCHIVE := awf-workflow-$(PACK_NAME)_$(VERSION).tar.gz

# Release archive for `awf workflow install`: the committed files of HEAD, without the test suites and their fixtures.
pack:
	git archive --format=tar.gz -o $(ARCHIVE) HEAD -- manifest.yaml README.md LICENSE NOTICE workflows prompts scripts skills hooks examples \
		':(exclude)scripts/*.test.mts' ':(exclude)scripts/fixtures'
	sha256sum $(ARCHIVE) > checksums.txt

test:
	node --test scripts/*.test.mts

clean:
	rm -f awf-workflow-*.tar.gz checksums.txt

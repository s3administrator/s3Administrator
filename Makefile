.PHONY: run install reset

run:
	npm run dev

install:
	npm install
	npm run prisma:generate

# Wipe the embedded postgres + secrets (lives under
# ~/Library/Application Support/s3-administrator/).
reset:
	rm -rf "$$HOME/Library/Application Support/s3-administrator"

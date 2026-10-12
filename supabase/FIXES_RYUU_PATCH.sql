-- Separate additive patch for an existing Fixes installation.
BEGIN;
ALTER TABLE public.fixes_catalog ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'luatools';
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.fixes_catalog'::regclass AND conname='fixes_catalog_provider_check') THEN
  ALTER TABLE public.fixes_catalog ADD CONSTRAINT fixes_catalog_provider_check CHECK (provider IN ('luatools','ryuu'));
 END IF;
END $$;
COMMIT;

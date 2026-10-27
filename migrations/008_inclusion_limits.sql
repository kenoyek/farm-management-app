ALTER TABLE ingredients ADD COLUMN inclusion_min numeric(10,6) NOT NULL DEFAULT 0 CHECK(inclusion_min BETWEEN 0 AND 100);
ALTER TABLE ingredients ADD COLUMN inclusion_max numeric(10,6) NOT NULL DEFAULT 100 CHECK(inclusion_max BETWEEN 0 AND 100);
ALTER TABLE ingredients ADD CONSTRAINT ordered_inclusion_limits CHECK(inclusion_min<=inclusion_max);

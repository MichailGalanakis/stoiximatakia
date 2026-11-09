ALTER TABLE users ADD COLUMN full_name text NOT NULL DEFAULT '' CHECK (length(full_name) <= 80);
ALTER TABLE users ADD COLUMN country text NOT NULL DEFAULT '' CHECK (length(country) <= 60);
ALTER TABLE users ADD COLUMN city text NOT NULL DEFAULT '' CHECK (length(city) <= 80);

CREATE TABLE public.family_book_statuses (
 id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
 book_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','reading','finished')),
 is_favorite BOOLEAN NOT NULL DEFAULT false, read_count INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
 version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT uq_family_book_status UNIQUE(family_id,book_id)
);

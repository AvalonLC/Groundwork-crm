-- Migration 0029: per-rep language preference
-- Adds preferred_language column to reps (default 'en', supports 'es')

ALTER TABLE reps ADD COLUMN preferred_language TEXT NOT NULL DEFAULT 'en';

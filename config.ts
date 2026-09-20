import dotenv from 'dotenv';
dotenv.config();

export const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
export const API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const ENV_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/environments';
export const DEFAULT_ENGINE = 'antigravity-preview-05-2026';
export const ENGINE_NAME = 'Antigravity Agent (antigravity-preview-05-2026)';

// DO NOT EDIT - This file is generated from openapi.json

import type { paths } from './types';

export interface ClientConfig {
  baseUrl?: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
}

export class DocForumClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private credentials: RequestCredentials;

  constructor(config: ClientConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:4000';
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
    this.credentials = config.credentials || 'include';
  }

  async health() {
    const response = await fetch(`${this.baseUrl}/health`, {
      method: 'GET',
      headers: this.headers,
      credentials: this.credentials,
    });
    return response.json() as Promise<{ status: 'ok' }>;
  }

  async signup(body: paths['/auth/signup']['post']['requestBody']['content']['application/json']) {
    const response = await fetch(`${this.baseUrl}/auth/signup`, {
      method: 'POST',
      headers: this.headers,
      credentials: this.credentials,
      body: JSON.stringify(body),
    });
    return response.json();
  }

  async login(body: paths['/auth/login']['post']['requestBody']['content']['application/json']) {
    const response = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: this.headers,
      credentials: this.credentials,
      body: JSON.stringify(body),
    });
    return response.json();
  }

  async getDoctors(params?: { specialty?: string; q?: string; limit?: number; cursor?: string }) {
    const query = new URLSearchParams();
    if (params?.specialty) query.append('specialty', params.specialty);
    if (params?.q) query.append('q', params.q);
    if (params?.limit) query.append('limit', String(params.limit));
    if (params?.cursor) query.append('cursor', params.cursor);
    const url = query.toString() ? `${this.baseUrl}/doctors?${query}` : `${this.baseUrl}/doctors`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers,
      credentials: this.credentials,
    });
    return response.json();
  }

  async getSpecialties() {
    const response = await fetch(`${this.baseUrl}/specialties`, {
      method: 'GET',
      headers: this.headers,
      credentials: this.credentials,
    });
    return response.json();
  }
}

export default DocForumClient;

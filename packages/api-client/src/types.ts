// DO NOT EDIT - This file is generated from openapi.json
// Regenerate with: node backend/scripts/gen-openapi.mjs

export interface paths {
  "/health": {
    get: {
      responses: {
        200: {
          content: {
            "application/json": {
              status: "ok";
            };
          };
        };
      };
    };
  };
  "/auth/signup": {
    post: {
      requestBody: {
        content: {
          "application/json": {
            role: "patient" | "doctor";
            email: string;
            password: string;
            fullName: string;
          };
        };
      };
      responses: {
        200: {
          content: {
            "application/json": any;
          };
        };
      };
    };
  };
  "/auth/login": {
    post: {
      requestBody: {
        content: {
          "application/json": {
            email: string;
            password: string;
          };
        };
      };
      responses: {
        200: {
          content: {
            "application/json": any;
          };
        };
      };
    };
  };
}

export interface components {
  schemas: Record<string, never>;
}

export interface operations {}

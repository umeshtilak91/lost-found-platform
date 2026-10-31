
const pool = require("../db");
const request = require("supertest");
const app = require("../server");

describe("GET /api/stats", () => {
  test("should return item statistics", async () => {
    const response = await request(app).get("/api/stats");

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveProperty("total");
    expect(response.body).toHaveProperty("lost");
    expect(response.body).toHaveProperty("found");
  });
});



describe("GET /api/lost-items", () => {
  test("should return lost items", async () => {
    const response = await request(app).get("/api/lost-items");

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});

describe("GET /api/found-items", () => {
  test("should return found items", async () => {
    const response = await request(app).get("/api/found-items");

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});

describe("GET /api/items/:id", () => {
  test("should return an item for a valid ID", async () => {
    const response = await request(app).get("/api/items/16");

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveProperty("id");
    expect(response.body).toHaveProperty("name");
  });

  test("should return 404 for an item that does not exist", async () => {
    const response = await request(app).get("/api/items/999999");

    expect(response.statusCode).toBe(404);
  });

  test("should return 400 for an invalid item ID", async () => {
    const response = await request(app).get("/api/items/abc");

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/lost-items pagination", () => {
  test("should return at most 5 items when limit is 5", async () => {
    const response = await request(app).get(
      "/api/lost-items?page=1&limit=5"
    );

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeLessThanOrEqual(5);
  });

  test("should return 400 for an invalid page number", async () => {
    const response = await request(app).get(
      "/api/lost-items?page=0&limit=5"
    );

    expect(response.statusCode).toBe(400);
  });

  test("should return 400 when limit is greater than 100", async () => {
    const response = await request(app).get(
      "/api/lost-items?page=1&limit=101"
    );

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/found-items pagination", () => {
  test("should return at most 5 items when limit is 5", async () => {
    const response = await request(app).get(
      "/api/found-items?page=1&limit=5"
    );

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeLessThanOrEqual(5);
  });

  test("should return 400 for an invalid page number", async () => {
    const response = await request(app).get(
      "/api/found-items?page=0&limit=5"
    );

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/report", () => {
  test("should return 401 when user is not authenticated", async () => {
    const response = await request(app)
      .post("/api/report")
      .send({
        name: "Test Wallet",
        location: "Pune",
        date: "2026-10-10",
        type: "lost",
      });

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toBe("Please login with Google first");
  });
});

// Close PostgreSQL pool after all tests in this file
afterAll(async () => {
  await pool.end();
});





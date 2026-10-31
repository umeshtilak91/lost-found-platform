const request = require("supertest");

jest.mock("../db", () => ({
    query: jest.fn(),
}));

const pool = require("../db");
const app = require("../server");
const createAuthenticatedApp = require("../test-utils/auth");

const authenticatedApp = createAuthenticatedApp(app, {
    id: 1,
});

describe("POST /api/report", () => {

    beforeEach(() => {
        jest.clearAllMocks();
        });
        test("should return 400 when name is missing", async () => {
            const response = await request(authenticatedApp)
                .post("/api/report")
                .send({
                    location: "Pune",
                    date: "2026-10-10",
                    type: "lost",
                });

            expect(response.statusCode).toBe(400);
            expect(response.body.message).toBe(
                "Name, location, date and type are required"
            );
        });

        test("should return 400 when location is missing", async () => {
            const response = await request(authenticatedApp)
                .post("/api/report")
                .send({
                    name: "Test Wallet",
                    date: "2026-10-10",
                    type: "lost",
                });

            expect(response.statusCode).toBe(400);
            expect(response.body.message).toBe(
                "Name, location, date and type are required"
            );
        });

        test("should return 400 when date is missing", async () => {
            const response = await request(authenticatedApp)
                .post("/api/report")
                .send({
                    name: "Test Wallet",
                    location: "Pune",
                    type: "lost",
                });

            expect(response.statusCode).toBe(400);
            expect(response.body.message).toBe(
                "Name, location, date and type are required"
            );
        });

        test("should return 400 when type is invalid", async () => {
            const response = await request(authenticatedApp)
                .post("/api/report")
                .send({
                    name: "Test Wallet",
                    location: "Pune",
                    date: "2026-10-10",
                    type: "stolen",
                });

            expect(response.statusCode).toBe(400);
            expect(response.body.message).toBe(
                "Type must be either lost or found"
            );
        });

        test("should return 400 when date is invalid", async () => {
            const response = await request(authenticatedApp)
                .post("/api/report")
                .send({
                    name: "Test Wallet",
                    location: "Pune",
                    date: "2026-99-99",
                    type: "lost",
                });

            expect(response.statusCode).toBe(400);
            expect(response.body.message).toBe(
                "Please provide a valid date"
            );
        });

        test("should return 400 when date is in the future", async () => {
            const futureDate = "2099-12-31";

            const response = await request(authenticatedApp)
                .post("/api/report")
                .send({
                    name: "Test Wallet",
                    location: "Pune",
                    date: futureDate,
                    type: "lost",
                });

            expect(response.statusCode).toBe(400);
            expect(response.body.message).toBe(
                "Date cannot be in the future"
            );
        });

        test("should create a report successfully", async () => {
            const mockItem = {
                id: 100,
                name: "Test Wallet",
                location: "Pune",
                date: "2026-10-10",
                description: "Black leather wallet",
                image: null,
                type: "lost",
                user_id: 1,
            };

            pool.query.mockResolvedValueOnce({
                rows: [mockItem],
            });

            const response = await request(authenticatedApp)
                .post("/api/report")
                .send({
                    name: "Test Wallet",
                    location: "Pune",
                    date: "2026-10-10",
                    description: "Black leather wallet",
                    type: "lost",
                });

            expect(response.statusCode).toBe(201);
            expect(response.body.message).toBe(
                "Lost/Found item reported successfully!"
            );
            expect(response.body.item).toMatchObject(mockItem);
            expect(pool.query).toHaveBeenCalledTimes(1);
        });

        test("should return 500 when database query fails", async () => {
            pool.query.mockRejectedValueOnce(
                new Error("Database connection failed")
            );

            const response = await request(authenticatedApp)
                .post("/api/report")
                .send({
                    name: "Test Wallet",
                    location: "Pune",
                    date: "2026-10-10",
                    description: "Black leather wallet",
                    type: "lost",
                });

            expect(response.statusCode).toBe(500);
            expect(response.body.message).toBe("Database Error");
            expect(pool.query).toHaveBeenCalledTimes(1);
        });

    });
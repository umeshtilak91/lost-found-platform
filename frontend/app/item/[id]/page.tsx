"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import BackButton from "../../../components/BackButton";

type Item = {
  id: number;
  name: string;
  location: string;
  date: string;
  description: string;
  image: string | null;
  type: string;
  user_name?: string | null;
  user_email?: string | null;
  user_profile_image?: string | null;
};

export default function ItemDetailsPage() {
  const params = useParams();
  const id = params.id;

  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchItem() {
      try {
        const response = await fetch(
          `http://localhost:5000/api/items/${id}`
        );

        if (!response.ok) {
          throw new Error(`HTTP Error: ${response.status}`);
        }

        const data = await response.json();
        setItem(data);
      } catch (error) {
        console.error("Failed to fetch item:", error);
      } finally {
        setLoading(false);
      }
    }

    if (id) {
      fetchItem();
    }
  }, [id]);

  if (loading) {
    return (
      <main
        style={{
          minHeight: "100vh",
          padding: "40px 20px",
          color: "white",
          background: "#020617",
        }}
      >
        <div style={{ maxWidth: "900px", margin: "0 auto" }}>
          <BackButton />
          <p style={{ marginTop: "30px", color: "#94a3b8" }}>
            Loading item...
          </p>
        </div>
      </main>
    );
  }

  if (!item) {
    return (
      <main
        style={{
          minHeight: "100vh",
          padding: "40px 20px",
          color: "white",
          background: "#020617",
        }}
      >
        <div style={{ maxWidth: "900px", margin: "0 auto" }}>
          <BackButton />
          <h2 style={{ marginTop: "30px" }}>Item not found</h2>
        </div>
      </main>
    );
  }

  const formattedDate = new Date(item.date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const isFound = item.type === "found";

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "30px 20px 60px",
        color: "white",
        background:
          "radial-gradient(circle at 10% 15%, rgba(37, 99, 235, 0.25), transparent 30%), radial-gradient(circle at 90% 85%, rgba(124, 58, 237, 0.2), transparent 30%), #020617",
      }}
    >
      <div
        style={{
          maxWidth: "900px",
          margin: "0 auto",
        }}
      >
        <BackButton />

        {/* Main Card */}
        <div
          style={{
            marginTop: "25px",
            borderRadius: "20px",
            overflow: "hidden",
            background: "rgba(15, 23, 42, 0.9)",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
          }}
        >
          {/* Image */}
          {item.image && (
            <div
              style={{
                background: "#111827",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <img
                src={`http://localhost:5000/uploads/${item.image}`}
                alt={item.name}
                style={{
                  width: "100%",
                  maxHeight: "500px",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            </div>
          )}

          {/* Details */}
          <div
            style={{
              padding: "30px",
            }}
          >
            {/* Status */}
            <span
              style={{
                display: "inline-block",
                padding: "7px 15px",
                borderRadius: "999px",
                background: isFound ? "#166534" : "#991b1b",
                color: "white",
                fontSize: "13px",
                fontWeight: "bold",
                letterSpacing: "0.5px",
              }}
            >
              {isFound ? "FOUND ITEM" : "LOST ITEM"}
            </span>

            {/* Name */}
            <h1
              style={{
                fontSize: "36px",
                margin: "18px 0 25px",
              }}
            >
              {item.name}
            </h1>

            {/* Information */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "15px",
              }}
            >
              <div
                style={{
                  padding: "18px",
                  borderRadius: "12px",
                  background: "rgba(30, 41, 59, 0.7)",
                }}
              >
                <div
                  style={{
                    color: "#94a3b8",
                    fontSize: "13px",
                    marginBottom: "6px",
                  }}
                >
                  LOCATION
                </div>

                <div style={{ fontSize: "17px" }}>
                  📍 {item.location}
                </div>
              </div>

              <div
                style={{
                  padding: "18px",
                  borderRadius: "12px",
                  background: "rgba(30, 41, 59, 0.7)",
                }}
              >
                <div
                  style={{
                    color: "#94a3b8",
                    fontSize: "13px",
                    marginBottom: "6px",
                  }}
                >
                  DATE
                </div>

                <div style={{ fontSize: "17px" }}>
                  📅 {formattedDate}
                </div>
              </div>
            </div>

            {/* Description */}
            {item.description && (
              <div
                style={{
                  marginTop: "25px",
                  paddingTop: "25px",
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <h3 style={{ marginTop: 0 }}>
                  📝 Description
                </h3>

                <p
                  style={{
                    color: "#94a3b8",
                    lineHeight: "1.7",
                    fontSize: "16px",
                  }}
                >
                  {item.description}
                </p>
              </div>
            )}

            {/* Reporter */}
            {item.user_name && (
              <div
                style={{
                  marginTop: "30px",
                  paddingTop: "25px",
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <h3 style={{ marginTop: 0 }}>
                  👤 Reported by
                </h3>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "20px",
                    flexWrap: "wrap",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                    }}
                  >
                    {item.user_profile_image ? (
                      <img
                        src={item.user_profile_image}
                        alt=""
                        style={{
                          width: "50px",
                          height: "50px",
                          borderRadius: "50%",
                          objectFit: "cover",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: "50px",
                          height: "50px",
                          borderRadius: "50%",
                          background: "#2563eb",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: "bold",
                          fontSize: "20px",
                        }}
                      >
                        {item.user_name
                          .charAt(0)
                          .toUpperCase()}
                      </div>
                    )}

                    <div>
                      <strong style={{ fontSize: "17px" }}>
                        {item.user_name}
                      </strong>

                      <div
                        style={{
                          color: "#64748b",
                          fontSize: "13px",
                          marginTop: "3px",
                        }}
                      >
                        Item reporter
                      </div>
                    </div>
                  </div>

                  {/* Contact button */}
                  <button
                    type="button"
                    onClick={() => {
                      alert(
                        "💬 Private chat will be available soon!"
                      );
                    }}
                    style={{
                      border: "none",
                      borderRadius: "10px",
                      padding: "12px 20px",
                      background:
                        "linear-gradient(135deg, #2563eb, #4f46e5)",
                      color: "white",
                      fontSize: "15px",
                      fontWeight: "bold",
                      cursor: "pointer",
                      boxShadow:
                        "0 8px 20px rgba(37,99,235,0.25)",
                    }}
                  >
                    💬 Contact Reporter
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
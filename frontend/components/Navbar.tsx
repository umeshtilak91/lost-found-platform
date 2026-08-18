"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type User = {
  id: number;
  name: string;
  email: string;
  profile_image: string | null;
};

export default function Navbar() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetch("http://localhost:5000/api/auth/me", {
      credentials: "include",
    })
      .then((response) => response.json())
      .then((data) => {
        console.log("Auth response:", data);

        if (data.loggedIn) {
          setUser(data.user);
        }
      })
      .catch((error) => {
        console.error("Failed to check authentication:", error);
      });
  }, []);

  return (
    <nav
  style={{
    backgroundColor: "transparent",
    color: "white",
    padding: "15px 0",
    marginBottom: "20px",
  }}
>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "15px",
        }}
      >
        <h2 style={{ margin: 0 }}>🔍 Lost & Found Platform</h2>

        <div
          style={{
            display: "flex",
            gap: "10px",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <Link href="/" style={linkStyle}>
            🏠 Home
          </Link>

          <Link href="/lost" style={linkStyle}>
            🔍 Lost Items
          </Link>

          <Link href="/found" style={linkStyle}>
            🎒 Found Items
          </Link>

          <Link href="/report" style={linkStyle}>
            ➕ Report Item
          </Link>

          {user ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                marginLeft: "10px",
              }}
            >
              <div
                  style={{
                    width: "35px",
                    height: "35px",
                    borderRadius: "50%",
                    backgroundColor: "white",
                    color: "#2563eb",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: "bold",
                  }}
                >
                  {user.name.charAt(0).toUpperCase()}
                </div>
                
              

              <span style={{ fontWeight: "bold" }}>
                👤 {user.name}
              </span>

              <button
                onClick={() => {
                  window.location.href =
                    "http://localhost:5000/api/auth/logout";
                }}
                style={{
                  padding: "8px 12px",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Logout
              </button>
            </div>
          ) : (
            <a
              href="http://localhost:5000/api/auth/google"
              style={linkStyle}
            >
              🔐 Login with Google
            </a>
          )}
        </div>
      </div>
    </nav>
  );
}

const linkStyle = {
  color: "white",
  textDecoration: "none",
  padding: "8px 12px",
  borderRadius: "6px",
  backgroundColor: "rgba(255,255,255,0.15)",
};
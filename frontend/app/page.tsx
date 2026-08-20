"use client";

import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";
import Hero from "../components/Hero";

type Stats = {
  total: number;
  lost: number;
  found: number;
};

export default function Home() {
  const [stats, setStats] = useState<Stats>({
    total: 0,
    lost: 0,
    found: 0,
  });

  useEffect(() => {
    async function fetchStats() {
      try {
        const response = await fetch("http://localhost:5000/api/stats");

        if (!response.ok) {
          throw new Error(`HTTP Error: ${response.status}`);
        }

        const data: Stats = await response.json();

        setStats(data);
      } catch (error) {
        console.error("Failed to fetch statistics:", error);
      }
    }

    fetchStats();
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "40px 20px 60px",
        fontFamily: "Arial, sans-serif",
        color: "white",
        background:
          "radial-gradient(circle at 10% 15%, rgba(37, 99, 235, 0.35), transparent 30%), radial-gradient(circle at 90% 85%, rgba(124, 58, 237, 0.25), transparent 30%), #020617",
      }}
    >
      <div
        style={{
          maxWidth: "900px",
          margin: "0 auto",
        }}
      >
        <Navbar />

        <Hero />

        {/* Statistics */}
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "15px",
            marginTop: "30px",
            marginBottom: "30px",
          }}
        >
          <StatCard
            icon="📊"
            value={stats.total}
            label="Total Reports"
          />

          <StatCard
            icon="🔍"
            value={stats.lost}
            label="Lost Items"
          />

          <StatCard
            icon="🎒"
            value={stats.found}
            label="Found Items"
          />
        </section>

        {/* Features */}
        <section
          style={{
            padding: "25px",
            borderRadius: "16px",
            background: "rgba(15, 23, 42, 0.75)",
            border: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          <h2
            style={{
              marginTop: 0,
              marginBottom: "20px",
              fontSize: "24px",
            }}
          >
            ✨ What you can do
          </h2>

          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "15px",
            }}
          >
            <FeatureCard
              icon="🏠"
              title="Home"
              description="Welcome to the Lost & Found platform."
            />

            <FeatureCard
              icon="🔍"
              title="Search Lost Items"
              description="Look for items reported as lost."
            />

            <FeatureCard
              icon="📦"
              title="Lost Items"
              description="View recently reported lost items."
            />

            <FeatureCard
              icon="🎒"
              title="Found Items"
              description="See items that people have found."
            />

            <FeatureCard
              icon="➕"
              title="Report Item"
              description="Report something lost or found."
            />
          </div>
        </section>
      </div>
    </main>
  );
}

function StatCard({
  icon,
  value,
  label,
}: {
  icon: string;
  value: number;
  label: string;
}) {
  return (
    <div
      style={{
        padding: "16px 20px",
        borderRadius: "14px",
        textAlign: "center",
        background: "rgba(15, 23, 42, 0.8)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      <div
        style={{
          fontSize: "28px",
          marginBottom: "8px",
        }}
      >
        {icon}
      </div>

      <div
        style={{
          fontSize: "28px",
          fontWeight: "700",
          marginBottom: "5px",
        }}
      >
        {value}
      </div>

      <div
        style={{
          color: "#94a3b8",
          fontSize: "14px",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div
      style={{
        padding: "18px",
        borderRadius: "12px",
        background: "rgba(30, 41, 59, 0.8)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div
        style={{
          fontSize: "28px",
          marginBottom: "10px",
        }}
      >
        {icon}
      </div>

      <h3
        style={{
          margin: "0 0 8px",
          fontSize: "17px",
        }}
      >
        {title}
      </h3>

      <p
        style={{
          margin: 0,
          color: "#94a3b8",
          fontSize: "14px",
          lineHeight: "1.5",
        }}
      >
        {description}
      </p>
    </div>
  );
}
import Navbar from "../components/Navbar";
import Hero from "../components/Hero";

export default function Home() {
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

        {/* Features */}
        <section
          style={{
            marginTop: "30px",
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
        transition: "transform 0.2s ease",
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
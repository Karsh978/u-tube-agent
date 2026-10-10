// test-video.js
const body = {
  scenes: [
    {
      url: "https://picsum.photos/seed/1/1280/720",
      duration: 4,
      caption: "Test scene",
    },
    {
      url: "https://picsum.photos/seed/2/1280/720",
      duration: 4,
      caption: "Second scene",
    },
  ],
  aspect: "16:9",
  title: "test-video",
  voiceover: false,
};

console.log("Sending request to /api/buildVideo...");
console.time("video-build");

fetch("http://localhost:5000/api/buildVideo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})
  .then(async (res) => {
    console.timeEnd("video-build");
    console.log("Status:", res.status);
    console.log("Headers:", Object.fromEntries(res.headers));
    if (!res.ok) {
      const txt = await res.text();
      console.error("Error response:", txt);
      process.exit(1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const fs = require("fs");
    fs.writeFileSync("test-video.mp4", buf);
    console.log("✅ Saved: test-video.mp4 (" + Math.round(buf.length / 1024) + " KB)");
  })
  .catch((e) => {
    console.timeEnd("video-build");
    console.error("❌ Error:", e.message);
  });
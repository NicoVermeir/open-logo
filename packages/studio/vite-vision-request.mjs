export function createVisionRequest(body, env) {
  const imageBase64 = String(body.imageBase64 ?? "");
  const imageMimeType = String(body.imageMimeType ?? "image/png");
  const imageWidth = String(body.imageWidth ?? "unknown");
  const imageHeight = String(body.imageHeight ?? "unknown");
  const instructions = String(body.instructions ?? "");
  const magnetCatalog = JSON.stringify(body.magnetCatalog ?? []);
  return {
    model: env.OPENLOGO_LLM_MODEL || undefined,
    reasoning_effort: env.OPENLOGO_LLM_REASONING_EFFORT || undefined,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${instructions} Return exactly {"blocks":[...]} with each block containing name, arguments, bounds, confidence, and children. Bounds must use this image coordinate space: width ${imageWidth}, height ${imageHeight}. The supported magnet catalog is: ${magnetCatalog}`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Recognize this OpenLogo magnetic board." },
          {
            type: "image_url",
            image_url: {
              url: `data:${imageMimeType};base64,${imageBase64}`,
              detail: "low",
            },
          },
        ],
      },
    ],
  };
}

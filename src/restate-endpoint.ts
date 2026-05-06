import * as restateFetch from "@restatedev/restate-sdk/fetch";
import { appointmentObject } from "./appointment-service.js";

const restateIdentityKeys = process.env.RESTATE_IDENTITY_KEYS?.split(",")
  .map((key) => key.trim())
  .filter(Boolean);

export const restateEndpoint = restateFetch.createEndpointHandler({
  services: [appointmentObject],
  identityKeys: restateIdentityKeys?.length ? restateIdentityKeys : undefined,
});

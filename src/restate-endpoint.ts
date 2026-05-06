import * as restateFetch from "@restatedev/restate-sdk/fetch";
import {
  appointmentEmailService,
  appointmentObject,
} from "./appointment-service.js";

export const restateEndpoint = restateFetch.createEndpointHandler({
  services: [appointmentObject, appointmentEmailService],
});

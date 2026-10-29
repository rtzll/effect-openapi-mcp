import { Schema } from "effect";

export class NetworkFailure extends Schema.TaggedError<
  NetworkFailure,
  { readonly brand: unique symbol }
>()("NetworkFailure", { message: Schema.String }) {}
export class TimedOut extends Schema.TaggedError<
  TimedOut,
  { readonly brand: unique symbol }
>()("TimedOut", {
  message: Schema.String,
}) {}
export class ApiRejected extends Schema.TaggedError<
  ApiRejected,
  { readonly brand: unique symbol }
>()("ApiRejected", { message: Schema.String, status: Schema.Finite }) {}
export class RateLimited extends Schema.TaggedError<
  RateLimited,
  { readonly brand: unique symbol }
>()("RateLimited", {
  message: Schema.String,
  retryAfter: Schema.Option(Schema.String),
}) {}
export class InvalidResponse extends Schema.TaggedError<
  InvalidResponse,
  { readonly brand: unique symbol }
>()("InvalidResponse", { message: Schema.String }) {}
export class InvalidArguments extends Schema.TaggedError<
  InvalidArguments,
  { readonly brand: unique symbol }
>()("InvalidArguments", { message: Schema.String }) {}
export const API_FAILURE_SCHEMA = Schema.Union([
  NetworkFailure,
  TimedOut,
  ApiRejected,
  RateLimited,
  InvalidResponse,
  InvalidArguments,
]);
export type ApiFailure = typeof API_FAILURE_SCHEMA.Type;

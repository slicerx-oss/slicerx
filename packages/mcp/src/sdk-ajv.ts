// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Stands in for the SDK's validation/ajv-provider.js in the built server. The SDK's Server and Client import that
// module and build an Ajv instance in their constructors, so every start loaded Ajv and its formats, about seventy
// files, though only an elicitation answer is ever checked against a schema. This class has the same name and
// interface and loads the SDK's own provider the first time a schema is checked. The npm build points the SDK's
// import here with a module hook (src/sdk-ajv-hook.ts); the self-contained build swaps the import when it bundles.
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js'
import { sdkAjv } from './sdk-ajv-load'

export class AjvJsonSchemaValidator implements jsonSchemaValidator {
  private real: jsonSchemaValidator | undefined
  private readonly ajv: unknown

  /** As the SDK's: an Ajv instance of the caller's, or none for the SDK's default one. */
  constructor(ajv?: unknown) {
    this.ajv = ajv
  }

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    this.real ??= new (sdkAjv().AjvJsonSchemaValidator)(this.ajv as never)
    return this.real.getValidator<T>(schema)
  }
}


import { expect, test } from 'vitest'
import Agent, { isLegacyWebhookToken, kWebhookTokenBytes } from '@models/agent'

// obvious dummies: none of these is a real token
const kStrongToken = '0123456789abcdef0123456789abcdef'
const kLegacyToken = 'abc12345'

test('The format of a webhook token is 128 bits as hex', () => {
  expect(kWebhookTokenBytes).toBe(16)
  expect(kStrongToken).toHaveLength(kWebhookTokenBytes * 2)
})

test('No token is not a legacy token', () => {
  expect(isLegacyWebhookToken(undefined)).toBe(false)
  expect(isLegacyWebhookToken(null)).toBe(false)
  expect(isLegacyWebhookToken('')).toBe(false)
  expect(isLegacyWebhookToken(new Agent().webhookToken)).toBe(false)
})

test('A token of the current format is not a legacy token', () => {
  expect(isLegacyWebhookToken(kStrongToken)).toBe(false)
  expect(isLegacyWebhookToken('f'.repeat(32))).toBe(false)
  expect(isLegacyWebhookToken('0'.repeat(32))).toBe(false)
})

test('A token of the former 8 character format is a legacy token', () => {
  expect(isLegacyWebhookToken(kLegacyToken)).toBe(true)
  expect(isLegacyWebhookToken('zzzzzzzz')).toBe(true)
  expect(isLegacyWebhookToken('00000000')).toBe(true)
  // 8 characters are legacy even when they are all hex
  expect(isLegacyWebhookToken('deadbeef')).toBe(true)
})

test('A token of another length is a legacy token', () => {
  expect(isLegacyWebhookToken('a')).toBe(true)
  expect(isLegacyWebhookToken('a'.repeat(16))).toBe(true)
  expect(isLegacyWebhookToken('a'.repeat(31))).toBe(true)
  expect(isLegacyWebhookToken('a'.repeat(33))).toBe(true)
  expect(isLegacyWebhookToken('a'.repeat(64))).toBe(true)
})

test('A token of the right length that the generator cannot produce is a legacy token', () => {
  // not hex
  expect(isLegacyWebhookToken('g'.repeat(32))).toBe(true)
  expect(isLegacyWebhookToken('abcdefghijklmnopqrstuvwxyz012345')).toBe(true)
  // hex is generated in lower case
  expect(isLegacyWebhookToken(kStrongToken.toUpperCase())).toBe(true)
  // nothing around the token
  expect(isLegacyWebhookToken(` ${kStrongToken}`)).toBe(true)
  expect(isLegacyWebhookToken(`${kStrongToken}\n`)).toBe(true)
  expect(isLegacyWebhookToken(`${kStrongToken.slice(0, 31)}/`)).toBe(true)
})

test('A token that is not a string is a legacy token', () => {
  // agents are read from json files that can hold anything
  expect(isLegacyWebhookToken(12345678 as unknown as string)).toBe(true)
  expect(isLegacyWebhookToken(true as unknown as string)).toBe(true)
  expect(isLegacyWebhookToken({} as unknown as string)).toBe(true)
})

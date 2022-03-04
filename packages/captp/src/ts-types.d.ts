// @ts-check
/* eslint-disable */

import type { Callable, DataOnly, FunctionOnly, Remotable } from '@endo/eventual-send';

/**
 * In order to type using Trap with a handler TrapHandler<T>, this template type
 * examines its parameter, and transforms any Promise<R> function return types
 * or Promise<R> object property types into the corresponding resolved type R.
 *
 * That correctly describes that Trap(target)... "awaits" any results.
 */
export type TrapHandler<T> = T extends (...args: infer P) => infer R
  ? (...args: P) => Awaited<R>
  : T extends Record<string | number | symbol, Callable>
  ? {
      [K in keyof T]: Awaited<T[K]>;
    }
  : T;

/* Types for Trap proxy calls. */
type TrapSingleMethod<T> = {
  readonly [P in keyof T]: T[P] extends Callable ? (
    ...args: Parameters<T[P]>
  ) => Awaited<ReturnType<T[P]>> : never;
}
type TrapSingleCall<T> = T[P] extends Callable ?
  ((...args: Parameters<T>) => Awaited<ReturnType<T>>) &
    TrapSingleMethod<Required<T>> : TrapSingleMethod<Required<T>>;
type TrapSingleGet<T> = {
  readonly [P in keyof T]: Awaited<T[P]>;
}

export interface Trap {
  /**
   * @template T
   * 
   * Trap(x) returns a proxy on which you can call arbitrary methods. Each of
   * these method calls will unwrap a promise result.  The method will be
   * invoked on a remote 'x', and be synchronous from the perspective of this
   * caller.
   *
   * @param {T} x target for method/function call
   * @returns {TrapSingleCall} method/function call proxy
   */
  <T>(x: T): TrapSingleCall<
    T extends Remotable<infer U>
      ? FunctionOnly<U>
      : T extends Awaited<infer U>
      ? FunctionOnly<T>
      : never
  >;

  /**
   * @template T
   * 
   * Trap.get(x) returns a proxy on which you can get arbitrary properties.
   * Each of these properties unwraps a promise result.  The value will be the
   * property fetched from a remote 'x', and be synchronous from the perspective
   * of this caller.
   *
   * @param {T} x target for property get
   * @returns {TrapSingleGet} property get proxy
   */
  readonly get<T>(x: T): TrapSingleGet<
    T extends Remotable<infer U>
      ? DataOnly<U>
      : T extends Awaited<infer U>
      ? DataOnly<U>
      : never
  >;
}
